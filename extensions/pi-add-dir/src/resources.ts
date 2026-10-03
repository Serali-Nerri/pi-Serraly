import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { readTextFileBoundedSync } from "@henryqw/pi-config-store";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AddedDir } from "./directories.ts";

export const PROMPT_SECTION = "pi_add_dir";
export const CONTEXT_FILE_LIMIT = 64 * 1024;
export const CONTEXT_TOTAL_LIMIT = 128 * 1024;

const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const SKILL_DIRECTORIES = [".pi/skills", ".agents/skills", ".claude/skills"] as const;

export interface DirContext {
	agentsMd: string | null;
	claudeMd: string | null;
	/** Canonical SKILL.md candidates; validity and name collisions belong to the Pi loader. */
	skills: Set<string>;
	/** Instruction files that could not be read whole, reported once per binding. */
	skipped: string[];
}

export interface ContextInjection {
	text: string;
	skipped: string[];
}

function isRegularFile(path: string): boolean {
	const stat = statSync(path, { throwIfNoEntry: false });
	return stat !== undefined && stat.isFile();
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** Every instruction location read for one directory, in injection order. */
function instructionPaths(dir: string): string[] {
	return CONTEXT_FILES.flatMap((name) => [join(dir, name), join(dir, ".pi", name)]);
}

function readInstruction(path: string, skipped: string[]): string | null {
	try {
		if (!isRegularFile(path)) return null;
		return readTextFileBoundedSync(path, CONTEXT_FILE_LIMIT);
	} catch (error) {
		// Inspection failures (permissions, loops, unreadable parents) skip this one file
		// instead of aborting every other instruction in the section.
		skipped.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

function readContextFile(dir: string, name: string, skipped: string[] = []): string | null {
	const contents = [readInstruction(join(dir, name), skipped), readInstruction(join(dir, ".pi", name), skipped)].filter(
		(content): content is string => content !== null,
	);
	return contents.length > 0 ? contents.join("\n\n") : null;
}

function discoverSkillFiles(dir: string): string[] {
	const files: string[] = [];
	for (const skillDirectory of SKILL_DIRECTORIES) {
		const fullSkillDir = join(dir, skillDirectory);
		let entries;
		try {
			entries = readdirSync(fullSkillDir, { withFileTypes: true });
		} catch {
			// Missing or unreadable skill roots are simply absent candidates.
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			try {
				const skillPath = join(fullSkillDir, entry.name, "SKILL.md");
				if (isRegularFile(skillPath)) files.push(canonicalPath(skillPath));
			} catch {
				// One unreadable candidate must not abort discovery for the remaining skills.
			}
		}
	}
	return files;
}

export function scanDirContext(dir: string): DirContext {
	const skipped: string[] = [];
	return {
		agentsMd: readContextFile(dir, "AGENTS.md", skipped),
		claudeMd: readContextFile(dir, "CLAUDE.md", skipped),
		skills: new Set(discoverSkillFiles(dir)),
		skipped,
	};
}

export function collectSkillPaths(dirs: readonly AddedDir[]): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const dir of dirs) {
		for (const path of discoverSkillFiles(dir.absolutePath)) {
			if (seen.has(path)) continue;
			seen.add(path);
			paths.push(path);
		}
	}
	return paths;
}

export function contextSummary(context: DirContext): string {
	const found: string[] = [];
	if (context.agentsMd !== null) found.push("AGENTS.md");
	if (context.claudeMd !== null) found.push("CLAUDE.md");
	if (context.skills.size > 0) found.push(`${context.skills.size} skill(s)`);
	return found.length > 0 ? ` Found: ${found.join(", ")}.` : " No context files found.";
}

/**
 * Instruction files are read whole and skipped whole: a truncated file would silently
 * pretend the model saw instructions it never saw. The whole section, headings
 * included, stays within `CONTEXT_TOTAL_LIMIT`.
 */
export function buildContextInjection(dirs: readonly AddedDir[]): ContextInjection {
	const skipped: string[] = [];
	if (dirs.length === 0) return { text: "", skipped };
	const parts: string[] = [];
	let size = 0;
	function push(text: string): boolean {
		const candidate = size + (parts.length > 0 ? 1 : 0) + Buffer.byteLength(text);
		if (candidate > CONTEXT_TOTAL_LIMIT) return false;
		size = candidate;
		parts.push(text);
		return true;
	}
	push("\n\n## External Directories (added via pi-add-dir)");
	push(
		`\nThe following ${dirs.length} external director${dirs.length === 1 ? "y is" : "ies are"} included in this session. You can read, edit, and write files in these directories using absolute paths.\n`,
	);
	for (const dir of dirs) {
		if (!push(`### ${dir.label} - \`${dir.absolutePath}\``)) {
			// The budget ran out at this heading: report the instructions it hides instead of
			// dropping them silently, and keep reporting the directories after it.
			for (const path of instructionPaths(dir.absolutePath)) {
				if (readInstruction(path, skipped) !== null) {
					skipped.push(`${path}: exceeds the ${CONTEXT_TOTAL_LIMIT}-byte external instruction budget`);
				}
			}
			continue;
		}
		for (const path of instructionPaths(dir.absolutePath)) {
			const content = readInstruction(path, skipped);
			if (content === null) continue;
			const block = `\n#### ${relative(dir.absolutePath, path)} (from ${dir.label})\n${content}`;
			if (size + 1 + Buffer.byteLength(block) > CONTEXT_TOTAL_LIMIT) {
				skipped.push(`${path}: exceeds the ${CONTEXT_TOTAL_LIMIT}-byte external instruction budget`);
				continue;
			}
			push(block);
		}
	}
	return { text: parts.join("\n"), skipped };
}

export function loadedSkillPaths(commands: readonly SlashCommandInfo[]): string[] {
	const paths = new Set<string>();
	for (const command of commands) {
		if (command.source !== "skill") continue;
		const path = command.sourceInfo?.path;
		if (typeof path === "string" && path.length > 0) paths.add(resolve(path));
	}
	return [...paths];
}

/**
 * Derives "external skills need /reload" from what this binding actually handed to the
 * host and what the host actually loaded, instead of comparing adjacent directory edits.
 */
export class SkillReconciler {
	#provided = new Set<string>();

	reset(): void {
		this.#provided = new Set();
	}

	recordProvided(paths: readonly string[]): void {
		for (const path of paths) this.#provided.add(resolve(path));
	}

	evaluate(discovered: readonly string[], loaded: readonly string[]): boolean {
		const actual = new Set(loaded.map((path) => resolve(path)));
		const expected = new Set(discovered.map((path) => resolve(path)));
		for (const path of this.#provided) {
			// Candidates the host refused (name collision, invalid frontmatter) must not
			// keep asking for a reload that can never settle.
			if (!actual.has(path)) expected.delete(path);
		}
		const ours = new Set([...actual].filter((path) => this.#provided.has(path)));
		return expected.size !== ours.size || [...expected].some((path) => !ours.has(path));
	}
}
