import { basename } from "node:path";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	ResourcesDiscoverEvent,
} from "@earendil-works/pi-coding-agent";
import { createExternalAutocompleteProvider } from "./autocomplete.ts";
import {
	DIR_ADD_USAGE,
	dirExists,
	directoryKey,
	hasUnsafeCharacters,
	isWithinDir,
	matchesStoredPath,
	mergeScopedDirs,
	parseAddArgs,
	resolveDir,
	type AddedDir,
	type DirSource,
	type ScopedDir,
} from "./directories.ts";
import { directoryChoices, notify, PENDING_MESSAGE, reportList, updateWidget, warn } from "./presentation.ts";
import {
	PROMPT_SECTION,
	SkillReconciler,
	buildContextInjection,
	collectSkillPaths,
	contextSummary,
	loadedSkillPaths,
	scanDirContext,
} from "./resources.ts";
import {
	PROJECT_CONFIG_KEY,
	STATE_TYPE,
	createAddDirConfigStore,
	latestSessionDirs,
	mutateProjectConfig,
	readProjectPaths,
	type ExecLike,
} from "./storage.ts";

export interface AddDirOptions {
	/** Test isolation only; production always uses Pi's agent directory. */
	agentDir?: string;
}

interface DirResult {
	ok: boolean;
	message: string;
	/** False when the session was replaced while the write was in flight. */
	apply: boolean;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function addDirExtension(pi: ExtensionAPI, options: AddDirOptions = {}): void {
	const globalStore = createAddDirConfigStore(options.agentDir);
	const exec: ExecLike = (command, args, execOptions) => pi.exec(command, args, execOptions);
	const reconciler = new SkillReconciler();
	let lifetime = new AbortController();
	let sessionDirs: AddedDir[] = [];
	let projectPaths: string[] = [];
	let globalPaths: string[] = [];
	let managedDirs: ScopedDir[] = [];
	let activeDirs: ScopedDir[] = [];
	let currentCwd = "";
	let pending = false;
	let generation = 0;
	let treeGeneration = 0;
	/** The branch `sessionDirs`, `managedDirs` and `activeDirs` were derived from. */
	let cacheBinding: BranchBinding | undefined;
	let autocompleteRegistered = false;
	let shuttingDown = false;
	const reportedInstructionSkips = new Set<string>();

	function globalConfigError(error: unknown): Error {
		return new Error(`Cannot load pi-add-dir global config at ${globalStore.path}: ${messageOf(error)}`, { cause: error });
	}

	function loadGlobalPaths(): string[] {
		try {
			return globalStore.loadSync().value.directories;
		} catch (error) {
			throw globalConfigError(error);
		}
	}

	function persistState(dirs: readonly AddedDir[]): void {
		pi.appendEntry(STATE_TYPE, { dirs: dirs.map((dir) => ({ ...dir })) });
	}

	/**
	 * Pi records an entry in the live branch before it persists it, so a failed append may
	 * still have published the new state. Adopt whatever the branch actually holds so the
	 * module never contradicts the session, and report the durability failure to the caller.
	 */
	function commitSession(ctx: ExtensionContext, next: readonly AddedDir[]): string | undefined {
		try {
			persistState(next);
			sessionDirs = [...next];
			cacheBinding = bindingOf(ctx);
			return undefined;
		} catch (error) {
			try {
				sessionDirs = latestSessionDirs(ctx.sessionManager.getBranch());
			} catch {
				// The branch is unreadable too; keep the last known state.
			}
			cacheBinding = bindingOf(ctx);
			return messageOf(error);
		}
	}

	/** Recompute scope resolution; the caller decides when the widget and pending state update. */
	function rebuild(ctx: ExtensionContext, showWarnings = false): boolean {
		const previous = activeDirs.map(directoryKey);
		const snapshot = mergeScopedDirs({ cwd: ctx.cwd, sessionDirs, projectPaths, globalPaths });
		managedDirs = snapshot.managedDirs;
		activeDirs = snapshot.addedDirs;
		currentCwd = ctx.cwd;
		if (showWarnings) {
			for (const dir of snapshot.skipped) {
				warn(ctx, `Skipped ${dir.source} external directory ${dir.storedPath}: ${dir.inactiveReason}.`);
			}
		}
		const next = activeDirs.map(directoryKey);
		return previous.length !== next.length || previous.some((value, index) => value !== next[index]);
	}

	function restoreState(ctx: ExtensionContext, showWarnings = false): boolean {
		sessionDirs = latestSessionDirs(ctx.sessionManager.getBranch());
		return rebuild(ctx, showWarnings);
	}

	function refreshSkills(): boolean {
		const wasPending = pending;
		pending = reconciler.evaluate(collectSkillPaths(activeDirs), loadedSkillPaths(pi.getCommands()));
		return pending !== wasPending;
	}

	function registerTerminalUi(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || !ctx.hasUI || autocompleteRegistered) return;
		autocompleteRegistered = true;
		const registeredLifetime = lifetime;
		const registeredSessionId = ctx.sessionManager.getSessionId();
		ctx.ui.addAutocompleteProvider((current) => createExternalAutocompleteProvider(current, () => {
			// A retired UI binding must not rebuild or contribute to its replacement's session.
			if (shuttingDown || lifetime !== registeredLifetime || ctx.sessionManager.getSessionId() !== registeredSessionId) return [];
			ensureCacheBinding(ctx);
			return activeDirs;
		}));
	}

	function reportInstructionSkips(ctx: ExtensionContext, paths: readonly string[]): void {
		for (const path of paths) {
			if (reportedInstructionSkips.has(path)) continue;
			reportedInstructionSkips.add(path);
			warn(ctx, `Skipped external instructions ${path}.`);
		}
	}

	function publish(ctx: ExtensionContext): void {
		ensureCacheBinding(ctx);
		refreshSkills();
		updateWidget(ctx, activeDirs, pending);
	}

	// Directory mutations are serialized per binding: concurrent commands must validate against
	// committed state instead of a snapshot taken before the previous write landed.
	let mutations: Promise<unknown> = Promise.resolve();
	function serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = mutations.then(operation, operation);
		mutations = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	function settle(ctx: ExtensionContext, message: string): void {
		publish(ctx);
		notify(ctx, `${message}${pending ? " Run /reload to update external skills." : ""}`, "info");
	}

	/**
	 * What a command was admitted under: the epoch, plus the live branch Pi would append to.
	 * Pi re-points its live leaf before it emits `session_tree`, so an earlier handler can delay
	 * that event while a queued command is already waiting to run.
	 */
	interface BranchBinding {
		leafId: string | null;
		/** Every entry that already existed when the binding was taken. */
		knownEntries: ReadonlySet<string>;
		/** False when the host cannot resolve its own leaf entry, leaving only the epoch guard. */
		verifiable: boolean;
	}

	interface Admission extends BranchBinding {
		generation: number;
		treeGeneration: number;
		sessionId: string;
	}

	function bindingOf(ctx: ExtensionContext): BranchBinding {
		const entries = ctx.sessionManager.getEntries() as ReadonlyArray<{ id?: unknown }>;
		const leafId = ctx.sessionManager.getLeafId() ?? null;
		return {
			leafId,
			knownEntries: new Set(entries.flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : []))),
			verifiable: leafId === null || ctx.sessionManager.getEntry(leafId) !== undefined,
		};
	}

	function admissionOf(ctx: ExtensionContext): Admission {
		return { generation, treeGeneration, sessionId: ctx.sessionManager.getSessionId(), ...bindingOf(ctx) };
	}

	/**
	 * Walking up from the live leaf must land on the bound leaf — or on no leaf, for a session that
	 * was empty when the binding was taken. Only entries created afterwards count as the same
	 * branch: navigating into an entry that already existed replaces the state that was cached.
	 */
	function branchReaches(ctx: ExtensionContext, binding: BranchBinding): boolean {
		let current = ctx.sessionManager.getLeafId() ?? null;
		const seen = new Set<string>();
		while (current !== null && !seen.has(current)) {
			if (current === binding.leafId) return true;
			if (binding.knownEntries.has(current)) return false;
			seen.add(current);
			const entry = ctx.sessionManager.getEntry(current) as { parentId?: string | null } | undefined;
			if (!entry) return false;
			current = entry.parentId ?? null;
		}
		return current === binding.leafId;
	}

	/**
	 * `sessionDirs` and everything derived from it describe one branch. Pi moves the live leaf
	 * before it announces the change, so every reader of that cache re-binds it to the branch the
	 * host is really on — otherwise the next command would write one branch's cached directories
	 * onto another branch.
	 */
	function ensureCacheBinding(ctx: ExtensionContext): void {
		if (cacheBinding !== undefined && branchReaches(ctx, cacheBinding)) return;
		restoreState(ctx);
		cacheBinding = bindingOf(ctx);
		refreshSkills();
		updateWidget(ctx, activeDirs, pending);
	}

	/** Directory writes may outlive their session; never write or publish into a replaced binding or branch. */
	function isCurrent(admission: Admission, ctx: ExtensionContext): boolean {
		if (generation !== admission.generation || shuttingDown) return false;
		if (ctx.sessionManager.getSessionId() !== admission.sessionId) return false;
		return admission.verifiable ? branchReaches(ctx, admission) : treeGeneration === admission.treeGeneration;
	}

	async function writePersistentPath(
		source: "project" | "global",
		absolutePath: string,
		ctx: ExtensionContext,
		session: Admission,
	): Promise<string | undefined> {
		if (source === "global") {
			try {
				const config = await globalStore.update((current) => ({
					directories: current.directories.includes(absolutePath)
						? current.directories
						: [...current.directories, absolutePath],
				}));
				if (isCurrent(session, ctx)) globalPaths = config.directories;
			} catch (error) {
				throw new Error(`Cannot save pi-add-dir global config at ${globalStore.path}: ${messageOf(error)}`, { cause: error });
			}
			return undefined;
		}
		const current = await readProjectPaths(exec, ctx.cwd, true, lifetime.signal);
		// The read above suspends: a command that went stale meanwhile must not start its write.
		if (!isCurrent(session, ctx)) return undefined;
		projectPaths = current;
		if (current.some((path) => matchesStoredPath(path, absolutePath, ctx.cwd))) return undefined;
		await mutateProjectConfig(
			exec,
			["--replace-all", "--fixed-value", PROJECT_CONFIG_KEY, absolutePath, absolutePath],
			ctx.cwd,
			"save project directory",
			lifetime.signal,
			() => isCurrent(session, ctx),
		);
		// The mutation above is the commit point; the reread only reconciles the cache.
		try {
			const refreshed = await readProjectPaths(exec, ctx.cwd, true, lifetime.signal);
			if (isCurrent(session, ctx)) projectPaths = refreshed;
			return undefined;
		} catch (error) {
			if (isCurrent(session, ctx)) {
				// Never resolve stored paths here: a path that became unreadable must not turn a
				// committed write into a failure.
				projectPaths = [...current.filter((path) => path !== absolutePath), absolutePath];
			}
			return `Saved the project directory, but re-reading the project configuration failed: ${messageOf(error)}`;
		}
	}

	async function addDir(
		dirPath: string,
		source: DirSource,
		ctx: ExtensionContext,
		session: Admission,
	): Promise<DirResult> {
		const input = dirPath.trim();
		if (!input) return { ok: false, message: "Directory path must not be blank.", apply: true };
		if (hasUnsafeCharacters(input)) {
			return { ok: false, message: "Directory paths must not contain control characters or line separators.", apply: true };
		}

		let absolutePath: string;
		try {
			absolutePath = resolveDir(input, ctx.cwd);
		} catch (error) {
			return { ok: false, message: `Cannot access directory: ${messageOf(error)}`, apply: true };
		}
		// A clean spelling may still canonicalize through a link into an unsafe name.
		if (hasUnsafeCharacters(absolutePath)) {
			return { ok: false, message: "Directory paths must not contain control characters or line separators.", apply: true };
		}
		if (!dirExists(absolutePath)) return { ok: false, message: `Directory does not exist: ${absolutePath}`, apply: true };
		const exact = managedDirs.filter((dir) => dir.absolutePath === absolutePath);
		const sessionMatch = exact.find((dir) => dir.source === "session");
		const persistentMatch = exact.find((dir) => dir.source !== "session");
		if (persistentMatch || (source === "session" && sessionMatch)) {
			return {
				ok: false,
				message: `Already added in ${persistentMatch?.source ?? "session"} scope: ${absolutePath}`,
				apply: true,
			};
		}
		const cwdPath = resolveDir(ctx.cwd, ctx.cwd);
		if (isWithinDir(cwdPath, absolutePath) || isWithinDir(absolutePath, cwdPath)) {
			return { ok: false, message: "Directory overlaps current working directory scope.", apply: true };
		}
		const overlap = activeDirs.find(
			(dir) =>
				dir.absolutePath !== absolutePath &&
				(isWithinDir(dir.absolutePath, absolutePath) || isWithinDir(absolutePath, dir.absolutePath)),
		);
		if (overlap) {
			return { ok: false, message: `Directory overlaps already-added directory: ${overlap.absolutePath}`, apply: true };
		}

		const context = scanDirContext(absolutePath);
		const label = basename(absolutePath) || absolutePath;
		reportInstructionSkips(ctx, context.skipped);
		try {
			if (source === "session") {
				const failure = commitSession(ctx, [...sessionDirs, { absolutePath, label }]);
				if (failure) {
					if (isCurrent(session, ctx)) {
						rebuild(ctx);
						publish(ctx);
					}
					return { ok: false, message: `Cannot save session directories: ${failure}`, apply: isCurrent(session, ctx) };
				}
			} else {
				// Persist first: the durable write is the commit point, so a failure leaves the
				// session copy intact and no compensating append can land on another branch.
				const warning = await writePersistentPath(source, absolutePath, ctx, session);
				// Admission may still be current after rolling back past a queued sibling.
				// The cache can describe that sibling's leaf, so re-bind after the I/O too.
				if (isCurrent(session, ctx)) ensureCacheBinding(ctx);
				// A promotion whose session ended in flight must not append the old session's
				// list into the replacement branch; the durable write already stands.
				if (isCurrent(session, ctx) && sessionDirs.some((dir) => matchesStoredPath(dir.absolutePath, absolutePath, ctx.cwd))) {
					const next = sessionDirs.filter((dir) => !matchesStoredPath(dir.absolutePath, absolutePath, ctx.cwd));
					const failure = commitSession(ctx, next);
					if (failure) {
						if (isCurrent(session, ctx)) {
							rebuild(ctx);
							publish(ctx);
						}
						return {
							ok: false,
							message: `Added ${label} (${absolutePath}) to ${source} scope, but the session copy could not be removed: ${failure}`,
							apply: isCurrent(session, ctx),
						};
					}
				}
				if (warning && isCurrent(session, ctx)) warn(ctx, warning);
			}
		} catch (error) {
			return { ok: false, message: messageOf(error), apply: isCurrent(session, ctx) };
		}
		const message = `Added ${label} (${absolutePath}) to ${source} scope.${contextSummary(context)}`;
		if (!isCurrent(session, ctx)) return { ok: true, message, apply: false };
		rebuild(ctx);
		return { ok: true, message, apply: true };
	}

	async function removeDir(dir: ScopedDir, ctx: ExtensionContext, session: Admission): Promise<DirResult> {
		try {
			if (dir.source === "session") {
				const next = sessionDirs.filter((candidate) => candidate.absolutePath !== dir.storedPath);
				const failure = commitSession(ctx, next);
				if (failure) {
					if (isCurrent(session, ctx)) {
						rebuild(ctx);
						publish(ctx);
					}
					return { ok: false, message: `Cannot save session directories: ${failure}`, apply: isCurrent(session, ctx) };
				}
			} else if (dir.source === "global") {
				try {
					const config = await globalStore.update((current) => ({
						directories: current.directories.filter((path) => path !== dir.storedPath),
					}));
					if (isCurrent(session, ctx)) globalPaths = config.directories;
				} catch (error) {
					throw new Error(`Cannot save pi-add-dir global config at ${globalStore.path}: ${messageOf(error)}`, { cause: error });
				}
			} else {
				await mutateProjectConfig(
					exec,
					["--unset-all", "--fixed-value", PROJECT_CONFIG_KEY, dir.storedPath],
					ctx.cwd,
					"remove project directory",
					lifetime.signal,
					() => isCurrent(session, ctx),
				);
				if (isCurrent(session, ctx)) projectPaths = projectPaths.filter((path) => path !== dir.storedPath);
			}
		} catch (error) {
			return { ok: false, message: messageOf(error), apply: isCurrent(session, ctx) };
		}
		const message = `Removed ${dir.label} (${dir.storedPath}) from ${dir.source} scope.`;
		if (!isCurrent(session, ctx)) return { ok: true, message, apply: false };
		ensureCacheBinding(ctx);
		rebuild(ctx);
		return { ok: true, message, apply: true };
	}

	pi.on("resources_discover", (event: ResourcesDiscoverEvent, ctx) => {
		if (event.cwd !== currentCwd) return;
		ensureCacheBinding(ctx);
		const skillPaths = collectSkillPaths(activeDirs);
		reconciler.recordProvided(skillPaths);
		return skillPaths.length > 0 ? { skillPaths } : undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		// Pi reuses this instance when a session is replaced (new/resume/fork) while it has
		// already reset its own UI, so every session starts with fresh per-session state.
		generation += 1;
		const admission = admissionOf(ctx);
		const controller = new AbortController();
		lifetime = controller;
		shuttingDown = false;
		autocompleteRegistered = false;
		reportedInstructionSkips.clear();
		globalPaths = loadGlobalPaths();
		const paths = await readProjectPaths(exec, ctx.cwd, false, controller.signal);
		// Aborting cannot stop a read that already resolved, so a shutdown or a newer binding
		// that landed while Git was reading must still publish nothing.
		if (!isCurrent(admission, ctx)) return;
		projectPaths = paths;
		restoreState(ctx, true);
		cacheBinding = bindingOf(ctx);
		reconciler.reset();
		pending = false;
		updateWidget(ctx, activeDirs, pending);
		registerTerminalUi(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (shuttingDown) return;
		// Live branch IDs are authoritative: delayed delivery must not expire commands already
		// admitted on the target. The event epoch protects only admissions without a resolvable leaf.
		treeGeneration += 1;
		restoreState(ctx);
		cacheBinding = bindingOf(ctx);
		const becamePending = refreshSkills();
		updateWidget(ctx, activeDirs, pending);
		if (becamePending && pending) notify(ctx, PENDING_MESSAGE, "warning");
	});

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		lifetime.abort();
	});

	pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx) => {
		ensureCacheBinding(ctx);
		const sections = event.systemPromptOptions.sections;
		const injection = buildContextInjection(activeDirs);
		if (injection.text.length > 0) sections[PROMPT_SECTION] = injection.text;
		else delete sections[PROMPT_SECTION];
		reportInstructionSkips(ctx, injection.skipped);
	});

	pi.registerCommand("dir-add", {
		description: "Add an external directory to this session, project, or global scope",
		handler: async (args, ctx) => {
			// Admission is fixed before the prompt: a command admitted in one session or branch must
			// never write into the one that replaced it while it waited.
			const admitted = admissionOf(ctx);
			let parsed;
			try {
				parsed = parseAddArgs(args);
			} catch (error) {
				notify(ctx, messageOf(error), "error");
				return;
			}
			const source = parsed.source;
			let dirPath = parsed.path;
			if (!dirPath) {
				if (!ctx.hasUI) {
					notify(ctx, DIR_ADD_USAGE, "error");
					return;
				}
				const prompted = await ctx.ui.input("Directory path:", "");
				if (!isCurrent(admitted, ctx)) return;
				if (!prompted) return;
				dirPath = prompted;
			}
			const result = await serialize(async () => {
				// The queue can outlive the branch a command was admitted in, so admission is
				// validated once more inside it, before any write reads or replaces state.
				if (!isCurrent(admitted, ctx)) return { ok: true, message: "", apply: false };
				// The cached directories must describe the branch this command runs on.
				ensureCacheBinding(ctx);
				return addDir(dirPath, source, ctx, admitted);
			});
			const publishable = result.apply && isCurrent(admitted, ctx);
			if (!result.ok) {
				if (publishable) notify(ctx, result.message, "error");
				return;
			}
			if (publishable) settle(ctx, result.message);
		},
	});

	pi.registerCommand("dir-ls", {
		description: "List external directories and select one to remove",
		handler: async (_args, ctx) => {
			const admitted = admissionOf(ctx);
			ensureCacheBinding(ctx);
			if (managedDirs.length === 0) {
				const message = "No external directories added. Use /dir-add <path> to add one.";
				if (ctx.hasUI) notify(ctx, message, "info");
				else reportList([message]);
				return;
			}
			// Keep the objects the choices describe: the live list may change while the selector
			// is open, and an index into a stale array must never select a different directory.
			const entries = [...managedDirs];
			const choices = directoryChoices(entries);
			if (!ctx.hasUI) {
				reportList(choices);
				return;
			}
			const selected = await ctx.ui.select("External directories — select one to remove:", choices);
			// The selector can outlive its branch: a choice offered by the previous branch must not
			// remove a directory from the one now selected.
			if (!isCurrent(admitted, ctx)) return;
			const selectedIndex = selected === undefined ? -1 : choices.indexOf(selected);
			const dir = selectedIndex >= 0 ? entries[selectedIndex] : undefined;
			if (!dir) return;
			if (!managedDirs.some((candidate) => candidate.source === dir.source && candidate.storedPath === dir.storedPath)) {
				notify(ctx, "The directory list changed while the selector was open; nothing was removed.", "warning");
				return;
			}
			const result = await serialize(async () => {
				if (!isCurrent(admitted, ctx)) return { ok: true, message: "", apply: false };
				ensureCacheBinding(ctx);
				return removeDir(dir, ctx, admitted);
			});
			const publishable = result.apply && isCurrent(admitted, ctx);
			if (!result.ok) {
				if (publishable) notify(ctx, result.message, "error");
				return;
			}
			if (publishable) settle(ctx, result.message);
		},
	});
}
