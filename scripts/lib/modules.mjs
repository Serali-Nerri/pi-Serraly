import { resolve } from "node:path";

export const root = resolve(import.meta.dirname, "../..");
export const hostExternal = ["@earendil-works/*", "typebox", "typebox/*"];
export const modules = [
	{ directory: "ui", runtime: "pi-ui", entry: "src/index.ts", licenses: [
		"licenses/README.md", "licenses/claude-style-tools-LICENSE",
		"licenses/claude-style-tools-THIRD_PARTY_NOTICES.md", "licenses/pi-session-ui-LICENSE",
		"licenses/pi-session-ui-UPSTREAM.md", "licenses/LICENSES/marked.txt",
		"licenses/LICENSES/pi-cc-extensions.txt", "licenses/LICENSES/pi-compact-thinking.txt",
	] },
	{ directory: "questions", runtime: "pi-ask-user-question", entry: "src/index.ts", licenses: ["LICENSE", "UPSTREAM.md"] },
	{ directory: "loop", runtime: "pi-loop", entry: "src/index.ts", licenses: ["UPSTREAM.md"] },
	{ directory: "tools", runtime: "pi-tools", entry: "src/index.ts", licenses: ["LICENSE", "NOTICE", "UPSTREAM.md"],
		generatedLicenses: ["licenses/diff-BSD.txt"] },
	{ directory: "background-shell", runtime: "pi-background-shell", entry: "extensions/background-tasks.ts",
		compile: true, licenses: ["LICENSE", "UPSTREAM.md"], testCommand: "test:full" },
	{ directory: "docparser", runtime: "pi-docparser", entry: "extensions/docparser/index.ts",
		assets: ["native-worker.mjs", "native-protocol.mjs", "parse-output.mjs"],
		licenses: ["LICENSE", "THIRD_PARTY_NOTICES.md", "licenses/LiteParse-APACHE-2.0.txt", "UPSTREAM.md"] },
	{ directory: "add-dir", runtime: "pi-add-dir", entry: "src/index.ts", cjsRequire: true, licenses: ["LICENSE", "UPSTREAM.md"],
		generatedLicenses: ["licenses/pi-config-store-MIT.txt", "licenses/proper-lockfile-MIT.txt",
			"licenses/graceful-fs-ISC.txt", "licenses/retry-MIT.txt", "licenses/signal-exit-ISC.txt"] },
	{ directory: "subagents", runtime: "pi-subagents", entry: "src/index.ts",
		licenses: ["LICENSE", "UPSTREAM.md"], testCommand: "test", denyNetwork: true },
];

export const extensionEntries = modules.map(({ runtime }) => `./dist/${runtime}/index.js`);

/** Third-party license texts copied into a sealed artifact from the locked dependency tree. */
export const generatedLicenseSources = {
	"licenses/diff-BSD.txt": { package: "diff", file: "LICENSE" },
	"licenses/pi-config-store-MIT.txt": { package: "@henryqw/pi-config-store", file: "LICENSE" },
	"licenses/proper-lockfile-MIT.txt": { package: "proper-lockfile", file: "LICENSE" },
	"licenses/graceful-fs-ISC.txt": { package: "graceful-fs", file: "LICENSE" },
	// `retry` resolves to proper-lockfile's nested 0.12.0, not the hoisted 0.13.1.
	"licenses/retry-MIT.txt": { package: "retry", file: "License", from: "proper-lockfile" },
	"licenses/signal-exit-ISC.txt": { package: "signal-exit", file: "LICENSE.txt" },
};
