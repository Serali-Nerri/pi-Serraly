/** Only private tool-declaration data survives the synchronous handler; never a request recorder. */
export interface ObservedDeclaration {
	readonly name: string;
	readonly position: string;
	readonly definition: string;
	readonly description: string;
}
export interface ObservedUpdate {
	readonly kind: "addition" | "removal";
	readonly name: string;
	readonly position: string;
	readonly declaration?: ObservedDeclaration;
}
export interface ToolObservation {
	readonly observedAt: string;
	readonly status: "recognized" | "unknown";
	readonly summary: string;
	/** Effective only when the entire declaration protocol is recognized. */
	readonly declarations: readonly ObservedDeclaration[];
	readonly initialDeclarations: readonly ObservedDeclaration[];
	/** Ordered history in this payload, not a cross-request recorder. */
	readonly updates: readonly ObservedUpdate[];
	readonly placeholders: readonly string[];
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
	const unknown = (summary: string): ToolObservation => ({ observedAt, status: "unknown", summary, declarations: [], initialDeclarations: [], updates: [], placeholders: [] });
	try {
		if (!record(payload) || typeof data(payload, "model") !== "string" || typeof data(payload, "max_tokens") !== "number")
			return unknown("Unknown: unsupported payload format");
		const messages = data(payload, "messages");
		if (!Array.isArray(messages) || data(payload, "stream") !== true) return unknown("Unknown: unsupported payload format");
		const budget = { nodes: 20000, characters: 2 * 1024 * 1024 };
		const effective = new Map<string, ObservedDeclaration>();
		const updates: ObservedUpdate[] = [], placeholders: string[] = [];
		const decode = (tool: unknown, position: string): ObservedDeclaration => {
			if (!record(tool)) throw new Error("Unknown definition");
			const name = data(tool, "name"), description = data(tool, "description"), schema = data(tool, "input_schema");
			if (typeof name !== "string" || !name.trim() || typeof description !== "string" || !record(schema) || data(schema, "type") !== "object"
				|| data(tool, "defer_loading") !== undefined || name === "__pi_deferred_placeholder__" || data(tool, "type") !== undefined)
				throw new Error("Unknown definition");
			const properties = data(schema, "properties"), required = data(schema, "required");
			if ((properties !== undefined && !record(properties)) || (required !== undefined && !Array.isArray(required))) throw new Error("Malformed schema");
			if (Array.isArray(required)) {
				const requiredCount = arraySize(required);
				for (let field = 0; field < requiredCount; field++)
					if (typeof data(required, String(field)) !== "string") throw new Error("Malformed schema");
			}
			const definition: Record<string, unknown> = { name, description, input_schema: schema };
			for (const field of ["strict", "eager_input_streaming", "cache_control"]) {
				const value = data(tool, field);
				if (value !== undefined) definition[field] = value;
			}
			return { name, position, description, definition: JSON.stringify(copyJson(definition, budget), undefined, 2) };
		};
		const declaredTools = data(payload, "tools");
		const tools = declaredTools === undefined ? [] : declaredTools;
		if (!Array.isArray(tools)) return unknown("Unknown: malformed tool definitions");
		const toolCount = arraySize(tools);
		for (let index = 0; index < toolCount; index++) {
			if (--budget.nodes < 0) throw new Error("Too large");
			const tool = data(tools, String(index)), position = `$.tools[${index}]`;
			if (!record(tool)) throw new Error("Unknown definition");
			if (data(tool, "name") === "__pi_deferred_placeholder__") {
				// Recognize the pinned adapter's scaffolding, not arbitrary provider deferred definitions.
				const schema = data(tool, "input_schema");
				const properties = data(schema, "properties"), required = data(schema, "required");
				if (!record(schema) || placeholders.length || data(tool, "description") !== "Reserved placeholder. Never available. Never call this."
					|| data(tool, "defer_loading") !== true || data(schema, "type") !== "object"
					|| !record(properties) || Object.keys(properties).length || !Array.isArray(required) || arraySize(required) !== 0
					|| Object.keys(schema).some((key) => !["type", "properties", "required"].includes(key))
					|| Object.keys(tool).some((key) => !["name", "description", "input_schema", "defer_loading"].includes(key)))
					throw new Error("Unknown placeholder");
				placeholders.push(position);
				continue;
			}
			const declaration = decode(tool, position);
			if (effective.has(declaration.name)) throw new Error("Duplicate initial definition");
			effective.set(declaration.name, declaration);
		}
		const initialDeclarations = [...effective.values()];
		// Examine protocol tags only; text, tool results and schema occurrences remain content.
		const messageCount = arraySize(messages);
		for (let index = 0; index < messageCount; index++) {
			if (--budget.nodes < 0) throw new Error("Too large");
			const message = data(messages, String(index));
			const role = data(message, "role"), content = data(message, "content");
			if (typeof role !== "string" || !["user", "assistant", "system"].includes(role)) return unknown("Unknown: unsupported message structure");
			if (typeof content === "string") continue;
			if (!Array.isArray(content)) return unknown("Unknown: malformed message structure");
			const blockCount = arraySize(content);
			for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
				if (--budget.nodes < 0) throw new Error("Too large");
				const block = data(content, String(blockIndex)), type = data(block, "type");
				if (typeof type !== "string") return unknown("Unknown: malformed message structure");
				if (type !== "tool_addition" && type !== "tool_removal") {
					if (type.startsWith("tool_") && type !== "tool_use" && type !== "tool_result") throw new Error("Unknown protocol");
					continue;
				}
				if (role !== "system" || declaredTools === undefined || !record(block)
					|| Object.keys(block).some((key) => !["type", "tool", "cache_control"].includes(key))) throw new Error("Unknown native protocol");
				const tool = data(block, "tool"), position = `$.messages[${index}].content[${blockIndex}].tool`;
				if (!record(tool) || Object.keys(tool).some((key) => !(type === "tool_addition" ? ["type", "definition"] : ["type", "name"]).includes(key)))
					throw new Error("Unknown native shape");
				if (type === "tool_addition") {
					if (data(tool, "type") !== "tool_definition") throw new Error("Unknown addition");
					const declaration = decode(data(tool, "definition"), `${position}.definition`);
					effective.set(declaration.name, declaration);
					updates.push({ kind: "addition", name: declaration.name, position: declaration.position, declaration });
				} else {
					const name = data(tool, "name");
					if (data(tool, "type") !== "tool_reference" || typeof name !== "string" || !effective.delete(name)) throw new Error("Unknown removal");
					updates.push({ kind: "removal", name, position: `${position}.name` });
				}
			}
		}
		const declarations = [...effective.values()];
		const native = updates.length > 0 || placeholders.length > 0;
		return { observedAt, status: "recognized", declarations, initialDeclarations: native ? initialDeclarations : [], updates, placeholders,
			summary: native ? `Anthropic-shaped native · ${declarations.length} effective declarations · ${updates.length} ordered updates · ${placeholders.length} adapter placeholders`
				: `Anthropic-shaped collapsed · ${declarations.length} top-level declarations` };
	} catch {
		return unknown("Unknown: tool declaration decode failed");
	}
}
