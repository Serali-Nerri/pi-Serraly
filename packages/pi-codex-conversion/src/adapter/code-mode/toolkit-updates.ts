import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	isCodexDeveloperMessageDetails,
	type CodexDeveloperMessageDetails,
} from "../../developer-messages.ts";
import {
	formatCodeModeToolHelp,
	isCodeModeToolDiscoverable,
} from "../../tools/code-mode/custom-tool-prompt.ts";
import {
	codeModeGlobalName,
	translateCodeModeToolReferences,
	translateCodeModeUsage,
} from "../../tools/code-mode/tool-identity.ts";
import type { CodeModeToolDefinition } from "../../tools/code-mode/types.ts";

export const CODEX_TOOLKIT_UPDATE_TYPE = "codex-toolkit-update";

interface ToolkitTool {
	name: string;
	description: string;
	contract: string;
	namespace: string;
}

interface ToolkitUpdate extends CodexDeveloperMessageDetails {
	rootId: string;
	compactionId: string | null;
	content: string;
	tools: ToolkitTool[];
	unlisted?: string[];
	namespaces: Record<string, string>;
}

export function readToolkitUpdate(value: unknown): ToolkitUpdate {
	if (
		!isCodexDeveloperMessageDetails(value) ||
		!("rootId" in value) ||
		typeof value.rootId !== "string" ||
		!("compactionId" in value) ||
		(value.compactionId !== null && typeof value.compactionId !== "string") ||
		!("content" in value) ||
		typeof value.content !== "string" ||
		!("tools" in value) ||
		!Array.isArray(value.tools) ||
		!value.tools.every(
			(tool: unknown) =>
				tool &&
				typeof tool === "object" &&
				["name", "description", "contract", "namespace"].every(
					(key) => typeof (tool as Record<string, unknown>)[key] === "string",
				),
		) ||
		("unlisted" in value &&
			(!Array.isArray(value.unlisted) ||
				!value.unlisted.every((name: unknown) => typeof name === "string"))) ||
		!("namespaces" in value) ||
		!value.namespaces ||
		typeof value.namespaces !== "object" ||
		Array.isArray(value.namespaces) ||
		!Object.values(value.namespaces).every(
			(description) => typeof description === "string",
		)
	)
		throw new Error("Malformed persisted toolkit update");
	return value as ToolkitUpdate;
}

export function projectToolkitUpdate(entry: SessionEntry): SessionEntry {
	if (entry.type !== "custom" || entry.customType !== CODEX_TOOLKIT_UPDATE_TYPE)
		return entry;
	const update = readToolkitUpdate(entry.data);
	return {
		...entry,
		type: "custom_message",
		content: update.content,
		display: false,
		details: update,
	};
}

/** Record only at inference admission, after tool preparation. No queued turn or history rewrite. */
export function recordCodeModeToolkit(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, "sessionManager">,
	messages: readonly AgentMessage[],
	catalog: readonly CodeModeToolDefinition[],
	promptCatalog: readonly CodeModeToolDefinition[] = [],
): boolean {
	const visible = messages.flatMap((message) =>
		message.role === "custom" &&
		message.customType === CODEX_TOOLKIT_UPDATE_TYPE
			? [readToolkitUpdate(message.details)]
			: [],
	);
	const compactionId =
		ctx.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "compaction")?.id ?? null;
	const latest = visible.at(-1);
	const previous =
		latest?.compactionId === compactionId &&
		visible.some((update) => update.id === latest.rootId)
			? latest
			: undefined;
	const discoverable = catalog.filter(
		(tool) =>
			isCodeModeToolDiscoverable(tool) &&
			!("discovery" in tool && tool.discovery === "server"),
	);
	const current = new Map(
		discoverable.map((tool) => [codeModeGlobalName(tool.name), tool]),
	);
	const callable = new Set(
		catalog.map((tool) => codeModeGlobalName(tool.name)),
	);
	const standingPromoted = new Map(
		promptCatalog
			.filter((tool) => "command" in tool && !tool.deferLoading)
			.map((tool) => [codeModeGlobalName(tool.name), tool]),
	);
	const tools: ToolkitTool[] = discoverable
		.map((tool) => ({
			name: codeModeGlobalName(tool.name),
			description:
				"discovery" in tool && tool.discovery === "help"
					? excerpt(
							translateCodeModeToolReferences(
								tool.description ?? "",
								tool.name,
							),
						)
					: [
							translateCodeModeUsage(
								"discoveryUsage" in tool && tool.discoveryUsage
									? tool.discoveryUsage
									: tool.usage,
								tool.name,
							),
							excerpt(
								`${"disabledReason" in tool && tool.disabledReason ? "Disabled: " : ""}${tool.description || tool.promptSnippet || ""}`,
							),
						]
							.filter(Boolean)
							.join("\n"),
			contract: toolContract(tool),
			namespace: tool.namespace?.name ?? "",
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
	const namespaces: Record<string, string> = Object.fromEntries(
		discoverable
			.flatMap((tool) =>
				tool.namespace
					? [[tool.namespace.name, tool.namespace.description?.trim() ?? ""]]
					: [],
			)
			.sort(([left], [right]) => left!.localeCompare(right!)),
	);
	// Remember only previously announced tools, so a later removal can revoke the still-callable notice.
	const known = previous
		? [...previous.tools.map((tool) => tool.name), ...(previous.unlisted ?? [])]
		: [];
	const unlisted = known
		.filter((name) => !current.has(name) && callable.has(name))
		.sort();
	if (
		previous &&
		JSON.stringify([
			previous.tools,
			previous.namespaces,
			previous.unlisted ?? [],
		]) === JSON.stringify([tools, namespaces, unlisted])
	)
		return false;
	const oldTools = new Map(previous?.tools.map((tool) => [tool.name, tool]));
	const added = tools.filter((tool) => !oldTools.has(tool.name));
	const changed = tools.filter((tool) =>
		previous
			? oldTools.has(tool.name) &&
				JSON.stringify(tool) !== JSON.stringify(oldTools.get(tool.name))
			: standingPromoted.has(tool.name) &&
				tool.contract !== toolContract(standingPromoted.get(tool.name)!),
	);
	// A new context must override standing contracts even when the earlier removal update was lost.
	const removed = previous
		? known.filter((name) => !callable.has(name))
		: [...standingPromoted.keys()].filter((name) => !callable.has(name));
	const newlyUnlisted = unlisted.filter(
		(name) => !previous?.unlisted?.includes(name),
	);
	if (!previous && tools.length === 0 && removed.length === 0) return false;
	// Group only announcements: provenance does not change contracts or persisted snapshots.
	const registered = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	const descriptions = new Map(
		Object.entries(namespaces).filter(
			([name, description]) =>
				!previous || previous.namespaces[name] !== description,
		),
	);
	const groupedLines = (entries: ToolkitTool[], fullHelp = false): string[] => {
		const groups = new Map<
			string,
			{ name: string; namespace: string; tools: ToolkitTool[] }
		>();
		for (const entry of entries) {
			const tool = current.get(entry.name)!;
			let key = entry.namespace ? `namespace:${entry.namespace}` : "";
			let name = entry.namespace;
			if (!key && "invoke" in tool) {
				const source = registered.get(
					tool.topLevelName ?? tool.name,
				)?.sourceInfo;
				if (source && isAbsolute(source.path)) {
					key = `extension:${source.path}`;
					name = basename(source.path, extname(source.path));
					if (name === "index")
						name = basename(
							source.origin === "package" && source.baseDir
								? source.baseDir
								: dirname(source.path),
						);
				}
			}
			const group = groups.get(key);
			if (group) group.tools.push(entry);
			else
				groups.set(key, { name, namespace: entry.namespace, tools: [entry] });
		}
		return [...groups.values()]
			.sort((left, right) => left.name.localeCompare(right.name))
			.flatMap((group): string[] => {
				const description = descriptions.get(group.namespace);
				descriptions.delete(group.namespace);
				return [
					...(group.name ? [`## ${group.name}`] : []),
					...(description ? [description] : []),
					...group.tools.map((entry) => {
						const tool = current.get(entry.name)!;
						return fullHelp && !tool.deferLoading
							? `- ${entry.name}:\n${formatCodeModeToolHelp(tool)}`
							: `- ${entry.name}: ${entry.description}`;
					}),
				];
			});
	};
	const content = [
		previous
			? "Toolkit update — current contracts in ALL_TOOLS; supersedes earlier contracts"
			: standingPromoted.size || discoverable.some((tool) => !tool.deferLoading)
				? "Tool contracts in ALL_TOOLS; updates supersede standing usage"
				: "Deferred tools — contracts and arguments in ALL_TOOLS",
		...(!previous
			? groupedLines(
					tools.filter((tool) => current.get(tool.name)!.deferLoading),
				)
			: added.length
				? ["Added:", ...groupedLines(added, true)]
				: []),
		...(changed.length ? ["Changed:", ...groupedLines(changed, true)] : []),
		...Array.from(descriptions, ([name, description]) => [
			`## ${name}`,
			...(description ? [description] : []),
		]).flat(),
		...(newlyUnlisted.length
			? [
					`Unlisted: ${newlyUnlisted.join(", ")}. Still callable by name; omitted from ALL_TOOLS`,
				]
			: []),
		...(removed.length
			? [
					`Removed: ${removed.join(", ")}. No longer callable; ignore earlier usage`,
				]
			: []),
	].join("\n");
	const id = randomUUID();
	pi.appendEntry(CODEX_TOOLKIT_UPDATE_TYPE, {
		protocol: 1,
		id,
		rootId: previous?.rootId ?? id,
		compactionId,
		content,
		tools,
		namespaces,
		unlisted,
	} satisfies ToolkitUpdate);
	return true;
}

function toolContract(tool: CodeModeToolDefinition): string {
	const help = formatCodeModeToolHelp(tool);
	// Executor changes also invalidate custom-tool contracts without exposing command paths in context.
	return createHash("sha256")
		.update(
			"command" in tool
				? JSON.stringify([
						help,
						tool.command,
						tool.args,
						tool.input,
						tool.yieldTimeMs,
						tool.disabledReason,
					])
				: tool.discoveryUsage
					? JSON.stringify([help, tool.discoveryUsage])
					: help,
		)
		.digest("hex");
}

function excerpt(description: string): string {
	const line = description.replace(/\s+/g, " ").trim();
	return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
