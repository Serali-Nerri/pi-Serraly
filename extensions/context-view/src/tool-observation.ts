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

/** Structural checks on bounded, owned JSON only; annotations stay data and references are not resolved. */
function schemaShape(schema: unknown): boolean {
	if (typeof schema === "boolean") return true;
	if (!record(schema)) return false;
	const strings = (value: unknown): boolean => Array.isArray(value) && value.every((entry) => typeof entry === "string");
	const types = ["null", "boolean", "object", "array", "number", "integer", "string"];
	if (schema.type !== undefined && !(typeof schema.type === "string" ? types.includes(schema.type)
		: Array.isArray(schema.type) && schema.type.length > 0 && schema.type.every((type) => typeof type === "string" && types.includes(type)))) return false;
	if (schema.required !== undefined && !strings(schema.required)) return false;
	for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
		const value = schema[key];
		if (value !== undefined && (!record(value) || !Object.values(value).every(schemaShape))) return false;
	}
	for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
		const value = schema[key];
		if (value !== undefined && (!Array.isArray(value) || !value.every(schemaShape))) return false;
	}
	for (const key of ["additionalProperties", "additionalItems", "unevaluatedProperties", "unevaluatedItems", "propertyNames", "contains", "not", "if", "then", "else", "contentSchema"]) {
		if (schema[key] !== undefined && !schemaShape(schema[key])) return false;
	}
	if (schema.items !== undefined && !(Array.isArray(schema.items) ? schema.items.every(schemaShape) : schemaShape(schema.items))) return false;
	if (schema.dependentRequired !== undefined && (!record(schema.dependentRequired) || !Object.values(schema.dependentRequired).every(strings))) return false;
	if (schema.dependencies !== undefined && (!record(schema.dependencies)
		|| !Object.values(schema.dependencies).every((value) => Array.isArray(value) ? strings(value) : schemaShape(value)))) return false;
	return true;
}

function cacheControlShape(value: unknown): boolean {
	return value === undefined || value === null || (record(value) && value.type === "ephemeral"
		&& (value.ttl === undefined || value.ttl === "5m" || value.ttl === "1h")
		&& Object.keys(value).every((key) => key === "type" || key === "ttl"));
}

/** Capture failures are deliberately content-free and cannot escape into the host's error reporting. */
export function captureToolObservation(payload: unknown): ToolObservation {
	const observedAt = new Date().toISOString();
	const unknown = (summary: string): ToolObservation => ({ observedAt, status: "unknown", summary, declarations: [], initialDeclarations: [], updates: [], placeholders: [] });
	try {
		if (!record(payload) || typeof data(payload, "model") !== "string")
			return unknown("Unknown: unsupported payload format");
		const messages = data(payload, "messages");
		if (!Array.isArray(messages) || data(payload, "stream") !== true) return unknown("Unknown: unsupported payload format");
		const budget = { nodes: 20000, characters: 2 * 1024 * 1024 };
		const effective = new Map<string, ObservedDeclaration>();
		const updates: ObservedUpdate[] = [], placeholders: string[] = [];
		let protocol: "Anthropic-shaped" | "OpenAI Chat Completions-shaped" | undefined;
		const useProtocol = (shape: NonNullable<typeof protocol>) => {
			if (protocol !== undefined && protocol !== shape) throw new Error("Mixed declaration protocols");
			protocol = shape;
		};
		const decode = (tool: unknown, position: string): ObservedDeclaration => {
			if (!record(tool)) throw new Error("Unknown definition");
			if (data(tool, "type") === "function") {
				useProtocol("OpenAI Chat Completions-shaped");
				if (Object.keys(tool).some((key) => !["type", "function"].includes(key))) throw new Error("Unknown function wrapper");
				const fn = data(tool, "function");
				if (!record(fn) || Object.keys(fn).some((key) => !["name", "description", "parameters", "strict"].includes(key))) throw new Error("Unknown function definition");
				const name = data(fn, "name"), description = data(fn, "description"), schema = data(fn, "parameters"), strict = data(fn, "strict");
				if (typeof name !== "string" || !name.trim() || typeof description !== "string" || !record(schema) || data(schema, "type") !== "object"
					|| name === "__pi_deferred_placeholder__") throw new Error("Unknown function definition");
				const owned = copyJson({ name, description, parameters: schema, ...(strict === undefined ? {} : { strict }) }, budget) as Record<string, unknown>;
				if (!schemaShape(owned.parameters) || (owned.strict !== undefined && typeof owned.strict !== "boolean")) throw new Error("Malformed function definition");
				return { name, position: `${position}.function`, description, definition: JSON.stringify(owned, undefined, 2) };
			}
			useProtocol("Anthropic-shaped");
			const name = data(tool, "name"), description = data(tool, "description"), schema = data(tool, "input_schema");
			if (typeof name !== "string" || !name.trim() || typeof description !== "string" || !record(schema) || data(schema, "type") !== "object"
				|| data(tool, "defer_loading") !== undefined || name === "__pi_deferred_placeholder__" || data(tool, "type") !== undefined)
				throw new Error("Unknown definition");
			const definition: Record<string, unknown> = { name, description, input_schema: schema };
			for (const field of ["strict", "eager_input_streaming", "cache_control"]) {
				const value = data(tool, field);
				if (value !== undefined) definition[field] = value;
			}
			const owned = copyJson(definition, budget) as Record<string, unknown>;
			if (!schemaShape(owned.input_schema)) throw new Error("Malformed schema");
			if ((owned.strict !== undefined && typeof owned.strict !== "boolean")
				|| (owned.eager_input_streaming !== undefined && owned.eager_input_streaming !== null && typeof owned.eager_input_streaming !== "boolean")
				|| !cacheControlShape(owned.cache_control)) throw new Error("Malformed declaration option");
			return { name, position, description, definition: JSON.stringify(owned, undefined, 2) };
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
				useProtocol("Anthropic-shaped");
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
			if (typeof role !== "string" || !["user", "assistant", "system", "developer", "tool", "function"].includes(role)) return unknown("Unknown: unsupported message structure");
			const additions = data(message, "tools");
			if (additions !== undefined) {
				useProtocol("OpenAI Chat Completions-shaped");
				if (role !== "system" || !Array.isArray(additions)) throw new Error("Unknown system tools");
				const additionCount = arraySize(additions);
				for (let toolIndex = 0; toolIndex < additionCount; toolIndex++) {
					if (--budget.nodes < 0) throw new Error("Too large");
					const declaration = decode(data(additions, String(toolIndex)), `$.messages[${index}].tools[${toolIndex}]`);
					effective.set(declaration.name, declaration);
					updates.push({ kind: "addition", name: declaration.name, position: declaration.position, declaration });
				}
			}
			if ((content === undefined && additions !== undefined) || (protocol !== "Anthropic-shaped" && (role === "assistant" || role === "function") && content == null)) continue;
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
				useProtocol("Anthropic-shaped");
				if (role !== "system" || declaredTools === undefined || !record(block)
					|| Object.keys(block).some((key) => !["type", "tool", "cache_control"].includes(key))) throw new Error("Unknown native protocol");
				const cacheControl = data(block, "cache_control");
				if (cacheControl !== undefined && !cacheControlShape(copyJson(cacheControl, budget))) throw new Error("Malformed update option");
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
			summary: native ? `${protocol} native · ${declarations.length} effective declarations · ${updates.length} ordered updates · ${placeholders.length} adapter placeholders`
				: protocol ? `${protocol} collapsed · ${declarations.length} top-level declarations` : "No tool declarations · 0 top-level declarations" };
	} catch {
		return unknown("Unknown: tool declaration decode failed");
	}
}
