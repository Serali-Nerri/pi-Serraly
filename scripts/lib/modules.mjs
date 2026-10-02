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
		compile: true, licenses: ["LICENSE", "UPSTREAM.md"] },
	{ directory: "docparser", runtime: "pi-docparser", entry: "extensions/docparser/index.ts",
		assets: ["native-worker.mjs", "native-protocol.mjs", "parse-output.mjs"],
		licenses: ["LICENSE", "THIRD_PARTY_NOTICES.md", "licenses/LiteParse-APACHE-2.0.txt", "UPSTREAM.md"] },
];

export const extensionEntries = modules.map(({ runtime }) => `./dist/${runtime}/index.js`);
