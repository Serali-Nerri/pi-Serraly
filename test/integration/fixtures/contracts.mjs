// Hand-derived public registration contracts, NOT imported from implementation.
export const entries = [
	"./dist/pi-ui/index.js", "./dist/pi-ask-user-question/index.js", "./dist/pi-loop/index.js",
	"./dist/pi-tools/index.js", "./dist/pi-background-shell/index.js",
	"./dist/pi-add-dir/index.js", "./dist/pi-subagents/index.js",
];
export const toolsByEntry = [[], ["AskUserQuestion"], [], ["apply_patch", "grep", "find", "ls"],
	["bg_kill", "bg_logs", "bg_run", "bg_status"], [], ["Agent", "StopAgent", "AgentStatus"]];
export const commandsByEntry = [["ccstyle", "context"], [], ["loop"], [],
	["bg", "bg-clear", "bg-tasks", "jobs", "kill", "logs", "tasks"], ["dir-add", "dir-ls"], ["agents"]];
export const questionArgs = { questions: [{ question: "Which local database?", header: "Database", options: [
	{ label: "SQLite", description: "Embedded local database." },
	{ label: "Postgres", description: "Client/server database.", preview: "SELECT 1;" },
] }] };
export const patchInput = "*** Begin Patch\n*** Add File: boundary.txt\n+first\n+second\n*** End Patch";
