import assert from "node:assert/strict";
import test from "node:test";

import { runRuntimeAcceptance } from "./fixtures/runtime.mjs";

const extensionEntries = [
	"packages/pi-agent-board/changelog.ts",
	"packages/pi-agent-board/index.ts",
	"packages/pi-ask/index.ts",
	"packages/pi-auto-trees/index.ts",
	"packages/pi-browser/changelog.ts",
	"packages/pi-browser/dist/index.js",
	"packages/pi-codex-conversion/dist/index.js",
	"packages/pi-codex-imagegen/index.ts",
	"packages/pi-shepherdr/index.ts",
	"packages/pi-ui/dist/index.ts",
].sort();

test("released Pi 1.4 loads every imported package and completes session cleanup", {
	timeout: 120_000,
}, async () => {
	const report = await runRuntimeAcceptance();

	assert.deepEqual(report.loadErrors, []);
	assert.deepEqual(report.runtimeErrors, []);
	assert.equal(report.extensionCount, extensionEntries.length);
	assert.deepEqual(
		report.extensions.map((extension) => extension.path),
		extensionEntries,
	);
	assert.deepEqual(report.packageDirectories, [
		"packages/pi-agent-board",
		"packages/pi-ask",
		"packages/pi-auto-trees",
		"packages/pi-browser",
		"packages/pi-codex-conversion",
		"packages/pi-codex-imagegen",
		"packages/pi-shepherdr",
		"packages/pi-ui",
	]);
	assert.deepEqual(
		[
			...new Set(report.extensions.map((extension) => extension.package)),
		].sort(),
		report.packageDirectories.map((directory) =>
			directory.replace("packages/", ""),
		),
	);

	for (const tool of [
		"agents",
		"apply_patch",
		"ask",
		"browser",
		"exec",
		"exec_command",
		"imagegen",
		"view_image",
		"wait",
		"write_stdin",
	]) {
		assert.ok(report.tools.includes(tool), `missing registered tool ${tool}`);
	}
	for (const command of [
		"board",
		"browser",
		"codex",
		"ui",
		"end",
		"herdr",
		"marker",
		"prime",
	]) {
		assert.ok(
			report.commands.includes(command),
			`missing registered command ${command}`,
		);
	}
	assert.deepEqual(report.prompts, ["fold", "grill"]);

	for (const name of ["autoTrees", "ask"]) {
		assert.equal(
			report.config[name].readError,
			undefined,
			`${name} seed file should be readable`,
		);
		assert.equal(typeof report.config[name], "object");
	}
	assert.deepEqual(report.profiles, ["explorer", "general", "reviewer"]);
	assert.equal(report.profileMarker, true);
	assert.equal(report.viewer.protocol, "pi-board-viewer/1");
	assert.equal(report.viewer.startServer, "function");
	assert.equal(report.viewer.indexReferencesAssets, true);
	assert.ok(report.viewer.assets["web/index.html"] > 0);
	assert.ok(report.viewer.assets["web/app.js"] > 0);
	assert.ok(report.viewer.assets["web/style.css"] > 0);

	assert.equal(report.authFileExists, true);
	assert.deepEqual(report.authFile, {});
	assert.ok(
		report.modelFallbackMessage,
		"fixture should start without a configured model",
	);
	assert.deepEqual(report.projectEntries, []);

	assert.equal(report.execution.execCommand.isError, false);
	assert.equal(report.execution.execCommand.exitCode, 0);
	assert.match(report.execution.execCommand.output, /runtime-probe-ok/);
	assert.equal(report.execution.execCommand.sessionId, null);
	assert.equal(report.execution.applyPatch.isError, false);
	assert.equal(report.execution.applyPatch.status, "success");
	assert.ok(
		report.execution.applyPatch.createdFiles.some((path) =>
			path.endsWith("runtime-probe.txt"),
		),
		"apply_patch should report the created fixture file",
	);
	assert.equal(report.execution.applyPatch.fileText, "runtime-probe-ok\n");
	assert.ok(report.resources.bashWasm.bytes > 0);
	assert.equal(report.resources.bashWasm.valid, true);
	assert.equal(report.optionalIntegrations.codeMode.providers, 6);
	assert.deepEqual(report.optionalIntegrations.codeMode.allToolNames, [
		"agents",
		"ask",
		"board",
		"browser",
		"imagegen",
	]);
	assert.deepEqual(report.optionalIntegrations.promptMode.tools, [
		"agents",
		"ask",
		"board",
		"browser",
		"exec",
		"imagegen",
	]);
	assert.equal(report.optionalIntegrations.promptMode.errors, 0);
	assert.equal(
		report.optionalIntegrations.promptMode.imagegenActiveDescription,
		"Generate/edit images; no selectors=generate",
	);
	assert.equal(report.shutdownCleanup.codeModeProviders, 0);
	assert.equal(report.runtimeDisposed, true);
	assert.equal(report.workspaceRemoved, true);
});
