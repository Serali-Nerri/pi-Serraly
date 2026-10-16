import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

// JSON lines on stdout only; every diagnostic goes to this sandbox's report.
const config = JSON.parse(process.argv[2] || "{}");
const label = config.label ?? "user";
let calls = 0, effects = 0, late = false, exiting = false;
const report = (phase, extra = {}) => appendFileSync(process.env.SERRALY_REPORT,
	JSON.stringify({ phase, pid: process.pid, label, calls, effects, ...extra }) + "\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const text = (value) => ({ content: [{ type: "text", text: value }] });
const schema = { type: "object", properties: {}, additionalProperties: false };
const tools = () => [
	{ name: "peek", description: "Fixture peek sentinel, read-only local identity", inputSchema: schema,
		annotations: { readOnlyHint: true } },
	{ name: "effect", description: "Fixture effect, observable local mutation", inputSchema: schema },
	{ name: "mutate", description: "Add or withdraw the late fixture tool", inputSchema: {
		type: "object", properties: { action: { type: "string", enum: ["add", "withdraw"] } }, required: ["action"] } },
	...(late ? [{ name: "late", description: "Late fixture sentinel", inputSchema: schema }] : []),
];
async function exit(reason, code = 0) {
	if (exiting) return;
	exiting = true;
	if (config.cleanupGate && !existsSync(config.cleanupGate)) {
		report("mcp-exit-waiting", { reason });
		const end = Date.now() + 1000;
		while (!existsSync(config.cleanupGate) && Date.now() < end) await new Promise((done) => setTimeout(done, 10));
		if (!existsSync(config.cleanupGate)) { report("fixture-error", { error: "cleanup gate deadline" }); code = 9; }
	}
	report("mcp-exit", { reason });
	process.exit(code);
}
report("mcp-start", { guarded: process.env.NODE_OPTIONS?.includes("network-guard.mjs") === true });
process.on("SIGTERM", () => exit("SIGTERM"));
process.on("SIGINT", () => exit("SIGINT"));
const deadline = setTimeout(() => exit("fixture-deadline", 9), 60000);
deadline.unref();
const input = createInterface({ input: process.stdin });
input.on("close", () => exit("stdin-closed"));
input.on("line", async (line) => {
	let request;
	try {
		request = JSON.parse(line);
		if (request.id === undefined) return;
		let result;
		switch (request.method) {
			case "initialize": {
				report("mcp-initialize", { waiting: !!config.startupGate });
				const end = Date.now() + 12000;
				while (config.startupGate && !existsSync(config.startupGate)) {
					if (Date.now() >= end) throw new Error("startup gate deadline");
					await new Promise((done) => setTimeout(done, 10));
				}
				result = { protocolVersion: request.params.protocolVersion, capabilities: {
					tools: { listChanged: true }, resources: {} }, serverInfo: { name: "serraly-synthetic", version: "1" },
					instructions: "Isolated fixture sentinel tools and resources" };
				break;
			}
			case "ping": result = {}; break;
			case "tools/list": result = { tools: tools() }; report("mcp-list", { late }); break;
			case "tools/call": {
				const name = request.params.name;
				calls++;
				if (name === "effect") effects++;
				report("mcp-call", { name });
				if (name === "mutate") {
					late = request.params.arguments?.action === "add";
					result = text(late ? "late-added" : "late-withdrawn");
				} else if (name === "peek" || name === "effect" || (name === "late" && late)) {
					result = text(`mcp-sentinel:${label}:${name}:${process.pid}`);
				} else result = { ...text("unknown or withdrawn fixture tool"), isError: true };
				break;
			}
			case "resources/list":
				report("mcp-resource-list");
				result = { resources: [{ uri: "fixture://sentinel", name: "fixture sentinel", mimeType: "text/plain" }] }; break;
			case "resources/templates/list":
				report("mcp-resource-template-list");
				result = { resourceTemplates: [] }; break;
			case "resources/read":
				report("mcp-resource", { uri: request.params.uri });
				result = { contents: [{ uri: request.params.uri, mimeType: "text/plain", text: `resource-sentinel:${label}:${process.pid}` }] }; break;
			default: send({ id: request.id, error: { code: -32601, message: "unsupported fixture method" } }); return;
		}
		send({ id: request.id, result });
		if (request.method === "tools/call" && request.params.name === "mutate") {
			send({ method: "notifications/tools/list_changed" });
		}
	} catch (error) {
		report("fixture-error", { error: String(error) });
		if (request?.id !== undefined) send({ id: request.id, error: { code: -32603, message: String(error) } });
	}
});
