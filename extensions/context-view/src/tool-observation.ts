/** Only private tool-declaration data survives the synchronous handler; never a request recorder. */
export interface ObservedDeclaration {
	readonly name: string;
	readonly position: string;
	readonly definition: string;
}
export interface ToolObservation {
	readonly observedAt: string;
	readonly status: "recognized" | "unknown";
	readonly summary: string;
	readonly declarations: readonly ObservedDeclaration[];
}

/** Reads own data properties only: do not invoke payload getters or toJSON. */
function data(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") throw new Error("Not an object");
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (descriptor === undefined) return undefined;
	if (!("value" in descriptor)) throw new Error("Not data");
	return descriptor.value;
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function arraySize(value: unknown[]): number {
	const length = data(value, "length");
	if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 20000) throw new Error("Too large");
	return length;
}

/** Own JSON data, copied before any later handler can replace or mutate the business objects. */
function copyJson(value: unknown, budget: { nodes: number; characters: number }, ancestors = new Set<object>(), depth = 0): unknown {
	if (--budget.nodes < 0 || depth > 64) throw new Error("Too large");
	if (typeof value === "string") {
		budget.characters -= value.length;
		if (budget.characters < 0) throw new Error("Too large");
		return value;
	}
	if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
	if (typeof value !== "object" || ancestors.has(value)) throw new Error("Not JSON data");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const length = arraySize(value);
			if (length > budget.nodes) throw new Error("Too large");
			return Array.from({ length }, (_, index) => copyJson(data(value, String(index)), budget, ancestors, depth + 1));
		}
		const result: Record<string, unknown> = Object.create(null);
		for (const key of Object.keys(value)) {
			budget.characters -= key.length;
			if (budget.characters < 0) throw new Error("Too large");
			result[key] = copyJson(data(value, key), budget, ancestors, depth + 1);
		}
		return result;
	} finally { ancestors.delete(value); }
}

/** Capture failures are deliberately content-free and cannot escape into the host's error reporting. */
export function captureToolObservation(payload: unknown): ToolObservation {
	const observedAt = new Date().toISOString();
	const unknown = (summary: string): ToolObservation => ({ observedAt, status: "unknown", summary, declarations: [] });
	try {
		if (!record(payload) || typeof data(payload, "model") !== "string" || typeof data(payload, "max_tokens") !== "number")
			return unknown("Unknown: unsupported payload format");
		const messages = data(payload, "messages");
		if (!Array.isArray(messages) || data(payload, "stream") !== true) return unknown("Unknown: unsupported payload format");
		// Examine only structural tags, not text/schema occurrences in ordinary messages.
		let remaining = 20000;
		const messageCount = arraySize(messages);
		for (let index = 0; index < messageCount; index++) {
			if (--remaining < 0) throw new Error("Too large");
			const message = data(messages, String(index));
			const role = data(message, "role"), content = data(message, "content");
			if (typeof role !== "string" || !["user", "assistant", "system"].includes(role)) return unknown("Unknown: unsupported message structure");
			if (typeof content === "string") continue;
			if (!Array.isArray(content)) return unknown("Unknown: malformed message structure");
			const blockCount = arraySize(content);
			for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
				if (--remaining < 0) throw new Error("Too large");
				const type = data(data(content, String(blockIndex)), "type");
				if (type === "tool_addition" || type === "tool_removal") return unknown("Unknown: native updates unimplemented");
				if (typeof type !== "string") return unknown("Unknown: malformed message structure");
			}
		}
		const declaredTools = data(payload, "tools");
		const tools = declaredTools === undefined ? [] : declaredTools;
		if (!Array.isArray(tools)) return unknown("Unknown: malformed tool definitions");
		const declarations: ObservedDeclaration[] = [];
		const names = new Set<string>();
		const budget = { nodes: 20000, characters: 2 * 1024 * 1024 };
		const toolCount = arraySize(tools);
		for (let index = 0; index < toolCount; index++) {
			const tool = data(tools, String(index));
			const name = data(tool, "name"), description = data(tool, "description"), schema = data(tool, "input_schema");
			if (name === "__pi_deferred_placeholder__" || data(tool, "defer_loading") === true)
				return unknown("Unknown: native updates unimplemented");
			if (typeof name !== "string" || !name.trim() || names.has(name) || typeof description !== "string" || !record(schema) || data(schema, "type") !== "object")
				return unknown("Unknown: malformed tool definitions");
			const properties = data(schema, "properties"), required = data(schema, "required");
			if ((properties !== undefined && !record(properties)) || (required !== undefined && !Array.isArray(required)))
				return unknown("Unknown: malformed tool definitions");
			if (Array.isArray(required)) {
				const requiredCount = arraySize(required);
				for (let field = 0; field < requiredCount; field++)
					if (typeof data(required, String(field)) !== "string") return unknown("Unknown: malformed tool definitions");
			}
			names.add(name);
			const definition: Record<string, unknown> = { name, description, input_schema: schema };
			for (const field of ["strict", "eager_input_streaming", "cache_control"]) {
				const value = data(tool, field);
				if (value !== undefined) definition[field] = value;
			}
			declarations.push({ name, position: `$.tools[${index}]`, definition: JSON.stringify(copyJson(definition, budget), undefined, 2) });
		}
		return { observedAt, status: "recognized", summary: `Anthropic-shaped collapsed · ${declarations.length} top-level declarations`, declarations };
	} catch {
		return unknown("Unknown: tool declaration decode failed");
	}
}
