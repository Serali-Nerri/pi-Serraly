import type { ToolExecutionStartEvent, ToolExecutionUpdateEvent, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import type { NestedToolCalls } from "@earendil-works/pi-ai";
import { sanitizeToolResultText } from "../utils/tool-result-sanitize.ts";

export type RecordedOperation = {
	id?: string;
	name: string;
	arguments?: any;
};

/** Recorded object identity is the exact string, never a filesystem lookup. */
export function summarizeOperations(operations: Iterable<RecordedOperation>): string[] {
	const files = new Set<string>();
	const patterns = new Set<string>();
	const directories = new Set<string>();
	const other = new Map<string, number>();
	const ids = new Set<string>();
	let shell = 0;
	for (const operation of operations) {
		if (operation.id) {
			if (ids.has(operation.id)) continue;
			ids.add(operation.id);
		}
		const name = operation.name.split(".").pop();
		const args = operation.arguments ?? {};
		const object = name === "read" ? args.path ?? args.file_path ?? args.file
			: name === "grep" || name === "find" ? args.pattern
			: name === "ls" ? args.path : undefined;
		if (typeof object === "string" && object.length > 0) {
			if (name === "read") { files.add(object); continue; }
			if (name === "grep" || name === "find") { patterns.add(object); continue; }
			if (name === "ls") { directories.add(object); continue; }
		}
		if (name === "bash" || name === "powershell") { shell++; continue; }
		const label = sanitizeToolResultText(operation.name).replace(/\s+/g, " ").trim();
		other.set(label, (other.get(label) ?? 0) + 1);
	}
	const parts: string[] = [];
	const append = (count: number, prefix: string, noun: string, plural = `${noun}s`) => {
		if (count) parts.push(`${prefix} ${count} ${count === 1 ? noun : plural}`);
	};
	append(patterns.size, "Searched for", "pattern");
	append(files.size, "Read", "file");
	append(directories.size, "Listed", "directory", "directories");
	append(shell, "Ran shell", "time");
	for (const [name, count] of other) append(count, `Used ${name}`, "time");
	return parts;
}

export type WorkToolEvent = ToolExecutionStartEvent | ToolExecutionUpdateEvent | ToolExecutionEndEvent;

type NestedOperation = RecordedOperation & { parentId: string; live: boolean };

function belongsToRoot(id: string, roots: Set<string>, operations: Map<string, NestedOperation>): boolean {
	const visited = new Set<string>();
	while (!visited.has(id)) {
		if (roots.has(id)) return true;
		visited.add(id);
		const parent = operations.get(id)?.parentId;
		if (!parent) return false;
		id = parent;
	}
	return false;
}

/** Public live observations and saved snapshots share call identity, not counters. */
export class WorkSummaryObservations {
	private readonly nested = new Map<string, NestedOperation>();
	private readonly partialParents = new Map<string, boolean>();

	observeExecution(event: WorkToolEvent): void {
		if (event.parentToolCallId) {
			const previous = this.nested.get(event.toolCallId);
			this.nested.set(event.toolCallId, {
				id: event.toolCallId,
				parentId: event.parentToolCallId,
				name: event.toolName,
				arguments: "args" in event ? event.args : previous?.arguments,
				live: true,
			});
		}
		if (event.type === "tool_execution_end") this.observeSnapshot(event.toolCallId, event.result?.nestedCalls);
	}

	observeMessage(message: any): void {
		if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
			this.observeSnapshot(message.toolCallId, message.nestedCalls);
		}
	}

	/** A selected projection replaces saved records, but not its unfinished live calls. */
	restoreMessages(messages: any[]): void {
		const previous = new Map(this.nested);
		const partial = new Map(this.partialParents);
		const ongoing = new Set<string>();
		for (const message of messages) {
			if (message?.role !== "assistant") continue;
			for (const item of Array.isArray(message.content) ? message.content : []) {
				if (item?.type === "toolCall" && typeof item.id === "string") ongoing.add(item.id);
			}
		}
		for (const message of messages) {
			if (message?.role === "toolResult") ongoing.delete(message.toolCallId);
		}
		this.nested.clear();
		this.partialParents.clear();
		for (const [id, operation] of previous) {
			if (operation.live && belongsToRoot(operation.parentId, ongoing, previous)) this.nested.set(id, operation);
		}
		for (const [id, live] of partial) {
			if (live && belongsToRoot(id, ongoing, previous)) this.partialParents.set(id, live);
		}
		for (const message of messages) {
			if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
				this.observeSnapshot(message.toolCallId, message.nestedCalls, false, previous);
			}
		}
	}

	private observeSnapshot(
		parentId: string,
		snapshot: NestedToolCalls | undefined,
		live = true,
		recorded = this.nested,
	): void {
		if (!snapshot || !Array.isArray(snapshot.calls)) return;
		if (snapshot.complete === false) this.partialParents.set(parentId, live);
		else this.partialParents.delete(parentId);
		for (const call of snapshot.calls) {
			const previous = recorded.get(call.id);
			this.nested.set(call.id, {
				id: call.id,
				parentId,
				name: call.name,
				arguments: call.arguments ?? previous?.arguments,
				live,
			});
		}
	}

	forCalls(rootIds: Set<string>): { operations: RecordedOperation[]; partial: boolean } {
		const belongs = (id: string) => belongsToRoot(id, rootIds, this.nested);
		return {
			operations: [...this.nested.values()].filter((operation) => belongs(operation.parentId)),
			partial: [...this.partialParents.keys()].some(belongs),
		};
	}
}
