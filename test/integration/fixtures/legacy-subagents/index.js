import { appendFileSync } from "node:fs";
import { Type } from "typebox";

// Local registration stand-in, not a copy or installation of the npm package.
export default function (pi) {
	appendFileSync(process.env.SERRALY_REPORT, JSON.stringify({ phase: "legacy-subagents-factory" }) + "\n");
	for (const name of ["Agent", "StopAgent", "AgentStatus"]) pi.registerTool({
		name, label: name, description: "Isolated legacy registration fixture", parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "Legacy fixture only" }], details: undefined }),
	});
	pi.registerCommand("agents", { description: "Isolated legacy fixture", handler: async () => {} });
}
