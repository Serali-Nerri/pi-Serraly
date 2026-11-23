import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createEventBus,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { packages, root } from "../../../scripts/lib/workspace.mjs";

async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function readJson(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		return {
			readError: error instanceof Error ? error.message : String(error),
		};
	}
}

function repoPath(directory, path) {
	return relative(directory, path).split(sep).join("/");
}

function restoreEnvironment(name, value) {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

/**
 * Run the released Pi host loader and lifecycle against the individual package
 * directories under `directory`, without their optional aggregate. No model is
 * selected or prompted; writes stay inside a disposable temporary directory.
 */
export async function runRuntimeAcceptance({ directory = root } = {}) {
	const workspace = await mkdtemp(join(tmpdir(), "pi-serraly-runtime-"));
	const cwd = join(workspace, "project");
	const agentDir = join(workspace, "agent");
	await Promise.all([
		mkdir(cwd, { recursive: true }),
		mkdir(agentDir, { recursive: true }),
	]);
	// Exercise both opt-in Agent Comms surfaces without changing real user settings.
	await writeFile(
		join(agentDir, "pi-agent-comms.json"),
		JSON.stringify({
			notes: { active: "all", normalCompaction: false },
			board: { enabledGlobally: true },
		}),
	);

	const savedEnv = {
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		HERDR_ENV: process.env.HERDR_ENV,
		HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_SOCKET_PATH;

	const packageEntries = (await packages(directory)).filter((entry) => entry.name !== "pi-extensions").map((entry) => ({
		name: entry.name,
		directory: entry.directory,
	}));
	let runtime;
	let report;

	try {
		const authPath = join(agentDir, "auth.json");
		const modelRuntime = await ModelRuntime.create({
			authPath,
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const settingsManager = SettingsManager.inMemory({});
		const sessionManager = SessionManager.inMemory(cwd);
		const extensionEventBus = createEventBus();
		const runtimeErrors = [];

		runtime = await createAgentSessionRuntime(
			async (options) => {
				const services = await createAgentSessionServices({
					cwd,
					agentDir,
					modelRuntime,
					settingsManager,
					resourceLoaderOptions: {
						eventBus: extensionEventBus,
						noExtensions: true,
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
						additionalExtensionPaths: packageEntries.map(
							(entry) => entry.directory,
						),
					},
				});
				const created = await createAgentSessionFromServices({
					services,
					sessionManager: options.sessionManager,
					noTools: "all",
					thinkingLevel: "off",
				});
				return { ...created, services, diagnostics: services.diagnostics };
			},
			{ cwd, agentDir, sessionManager },
		);

		const session = runtime.session;
		const loaded = session.resourceLoader.getExtensions();
		const extensions = loaded.extensions
			.map((extension) => ({
				path: repoPath(directory, extension.path),
				package: packageEntries.find((entry) =>
					extension.path.startsWith(`${entry.directory}${sep}`),
				)?.name,
			}))
			.sort((left, right) => left.path.localeCompare(right.path));

		await session.bindExtensions({
			onError(error) {
				runtimeErrors.push({
					extension: repoPath(directory, error.extensionPath),
					event: error.event,
					error: error.error,
				});
			},
		});

		const runner = session.extensionRunner;
		const registeredTools = new Map(
			runner
				.getAllRegisteredTools()
				.map((registered) => [
					registered.definition.name,
					registered.definition,
				]),
		);
		const tools = runner
			.getAllRegisteredTools()
			.map((registered) => registered.definition.name)
			.sort();
		const commands = runner
			.getRegisteredCommands()
			.map((command) => command.name)
			.sort();
		const prompts = session.resourceLoader
			.getPrompts()
			.prompts.map((prompt) => prompt.name)
			.sort();
		const projectEntries = await readdir(cwd);

		const codeModeProviders = [];
		extensionEventBus.emit(
			"@howaboua/pi-codex-conversion.extension-code-mode-tools/v1",
			{
				context: undefined,
				refreshGates: false,
				add(provider, active) {
					codeModeProviders.push({ provider, active });
				},
			},
		);
		const resolvedCodeModeProviders = codeModeProviders.map(
			({ provider, active }) => ({
				active,
				toolNames: provider(undefined).map(
					(tool) => tool.topLevelName ?? tool.name,
				),
			}),
		);
		const promptModeTools = [];
		const promptModeErrors = [];
		const imagegenOrdinaryDescription = registeredTools.get("imagegen")?.description;
		extensionEventBus.emit(
			"@howaboua/pi-codex-conversion.prompt-mode-prepare/v1",
			{
				active: true,
				context: undefined,
				errors: promptModeErrors,
				add(tools) {
					promptModeTools.push(...tools.map((tool) => tool.name));
				},
			},
		);
		const imagegenDescription = runner
			.getAllRegisteredTools()
			.find((registered) => registered.definition.name === "imagegen")
			?.definition.description;

		const abortController = new AbortController();
		const execTool = registeredTools.get("exec_command");
		const applyPatchTool = registeredTools.get("apply_patch");
		if (!execTool || !applyPatchTool) {
			throw new Error(
				"conversion tools were not registered before execution probes",
			);
		}
		const execResult = await execTool.execute(
			"runtime-acceptance-exec",
			{
				cmd: "printf 'runtime-probe-ok\\n'",
				workdir: cwd,
				yield_time_ms: 30_000,
			},
			undefined,
			undefined,
			runner.createToolContext(
				"runtime-acceptance-exec",
				abortController.signal,
			),
		);
		const patchResult = await applyPatchTool.execute(
			"runtime-acceptance-patch",
			{
				input:
					"*** Begin Patch\n*** Add File: runtime-probe.txt\n+runtime-probe-ok\n*** End Patch\n",
			},
			undefined,
			undefined,
			runner.createToolContext(
				"runtime-acceptance-patch",
				abortController.signal,
			),
		);
		const patchedFile = await readFile(join(cwd, "runtime-probe.txt"), "utf8");
		const execution = {
			execCommand: {
				exitCode: execResult.details?.exit_code,
				output: execResult.details?.output,
				sessionId: execResult.details?.session_id ?? null,
				isError: execResult.isError ?? false,
			},
			applyPatch: {
				status: patchResult.details?.status,
				createdFiles: patchResult.details?.result?.createdFiles ?? [],
				fileText: patchedFile,
				isError: patchResult.isError ?? false,
			},
		};
		const profilesDir = join(agentDir, "shepherdr", "profiles");
		const profiles = await readdir(profilesDir, { withFileTypes: true })
			.then((entries) =>
				entries
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name)
					.sort(),
			)
			.catch(() => []);

		const boardDir = packageEntries.find(
			(entry) => entry.name === "pi-agent-comms",
		)?.directory;
		const viewerDir = join(boardDir, "dist", "viewer");
		const viewerModule = await import(
			pathToFileURL(join(viewerDir, "server.js")).href
		);
		const viewerAssets = {};
		for (const asset of ["web/index.html", "web/app.js", "web/style.css"]) {
			viewerAssets[asset] = (await readFile(join(viewerDir, asset))).byteLength;
		}
		const conversionDir = packageEntries.find(
			(entry) => entry.name === "pi-codex-conversion",
		)?.directory;
		const bashWasm = await readFile(
			join(
				conversionDir,
				"vendor",
				"tree-sitter-bash",
				"tree-sitter-bash.wasm",
			),
		);

		report = {
			packageDirectories: packageEntries
				.map((entry) => repoPath(directory, entry.directory))
				.sort(),
			loadErrors: loaded.errors.map((error) => ({
				path: repoPath(directory, error.path),
				error: error.error,
			})),
			extensionCount: extensions.length,
			extensions,
			tools,
			commands,
			prompts,
			runtimeErrors,
			projectEntries,
			execution,
			optionalIntegrations: {
				codeMode: {
					providers: codeModeProviders.length,
					allToolNames: [
						...new Set(
							resolvedCodeModeProviders.flatMap(({ toolNames }) => toolNames),
						),
					].sort(),
					activeToolNames: [
						...new Set(
							resolvedCodeModeProviders
								.filter(({ active }) => active)
								.flatMap(({ toolNames }) => toolNames),
						),
					].sort(),
				},
				promptMode: {
					tools: [...new Set(promptModeTools)].sort(),
					errors: promptModeErrors.length,
					imagegenOrdinaryDescription,
					imagegenActiveDescription: imagegenDescription,
				},
			},
			config: {
				autoTrees: await readJson(join(agentDir, "pi-auto-trees.json")),
				ask: await readJson(join(agentDir, "ask.json")),
			},
			profiles,
			profileMarker: await pathExists(
				join(agentDir, "shepherdr", ".profiles-initialized"),
			),
			viewer: {
				protocol: viewerModule.PROTOCOL,
				startServer: typeof viewerModule.startServer,
				assets: viewerAssets,
				indexReferencesAssets: (
					await readFile(join(viewerDir, "web", "index.html"), "utf8")
				).includes('src="/app.js"'),
			},
			resources: {
				bashWasm: {
					bytes: bashWasm.byteLength,
					valid: WebAssembly.validate(bashWasm),
				},
			},
			authFileExists: await pathExists(authPath),
			authFile: await readJson(authPath),
			modelFallbackMessage: runtime.modelFallbackMessage ?? null,
		};

		await runtime.dispose();
		runtime = undefined;
		const postShutdownCodeModeProviders = [];
		extensionEventBus.emit(
			"@howaboua/pi-codex-conversion.extension-code-mode-tools/v1",
			{
				context: undefined,
				refreshGates: false,
				add(provider) {
					postShutdownCodeModeProviders.push(provider);
				},
			},
		);
		report.shutdownCleanup = {
			codeModeProviders: postShutdownCodeModeProviders.length,
		};
		report.runtimeDisposed = true;
		return report;
	} finally {
		if (runtime) {
			await runtime.dispose().catch(() => {});
		}
		await rm(workspace, { recursive: true, force: true });
		restoreEnvironment("PI_CODING_AGENT_DIR", savedEnv.PI_CODING_AGENT_DIR);
		restoreEnvironment("HERDR_ENV", savedEnv.HERDR_ENV);
		restoreEnvironment("HERDR_SOCKET_PATH", savedEnv.HERDR_SOCKET_PATH);
		if (report) {
			report.workspaceRemoved = !(await pathExists(workspace));
		}
	}
}
