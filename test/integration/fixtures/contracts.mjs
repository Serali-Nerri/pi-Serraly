// Hand-derived public registration contracts, NOT imported from implementation.
export const entriesByName = {
	"pi-add-dir": "./dist/pi-add-dir.js",
	"pi-ask-user-question": "./dist/pi-ask-user-question.js",
	"pi-background-shell": "./dist/extensions/background-tasks.js",
	"pi-loop": "./dist/pi-loop.js",
	"pi-subagents": "./dist/pi-subagents.js",
	"pi-tools": "./dist/pi-tools.js",
	"pi-ui": "./dist/pi-ui.js",
};
export const names = Object.keys(entriesByName);
export const releaseEntries = names.map((name) => `./extensions/${name}/${entriesByName[name].slice(2)}`);
export const toolsByName = {
	"pi-add-dir": [],
	"pi-ask-user-question": ["AskUserQuestion"],
	"pi-background-shell": ["bg_kill", "bg_logs", "bg_run", "bg_status"],
	"pi-loop": [],
	"pi-subagents": ["Agent", "StopAgent", "AgentStatus"],
	"pi-tools": ["apply_patch", "grep", "find", "ls"],
	"pi-ui": [],
};
export const commandsByName = {
	"pi-add-dir": ["dir-add", "dir-ls"],
	"pi-ask-user-question": [],
	"pi-background-shell": ["bg", "bg-clear", "bg-tasks", "jobs", "kill", "logs", "tasks"],
	"pi-loop": ["loop"],
	"pi-subagents": ["agents"],
	"pi-tools": [],
	"pi-ui": ["ccstyle", "context"],
};
export const questionArgs = { questions: [{ question: "Which local database?", header: "Database", options: [
	{ label: "SQLite", description: "Embedded local database." },
	{ label: "Postgres", description: "Client/server database.", preview: "SELECT 1;" },
] }] };
export const patchInput = "*** Begin Patch\n*** Add File: boundary.txt\n+first\n+second\n*** End Patch";
