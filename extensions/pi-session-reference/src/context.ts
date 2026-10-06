import { boundedText } from "./text.ts";

// Only explicit visible contributions from the host's effective context are exported.
// Structural metadata, tool arguments, attachments and hidden blocks are not text.
export function visibleMessage(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const value = message as Record<string, unknown>;
	let label: string;
	let body: string;
	let sourceWarning = "";
	switch (value.role) {
		case "user":
		case "assistant":
			label = value.role;
			body = textContent(value.content);
			break;
		case "toolResult":
			label = `Tool result (${typeof value.toolName === "string" ? value.toolName : "unknown"})`;
			body = textContent(value.content);
			break;
		case "compactionSummary":
		case "branchSummary":
			label = value.role === "compactionSummary" ? "Compaction summary" : "Branch summary";
			body = typeof value.summary === "string" ? value.summary : "";
			break;
		case "bashExecution":
			if (value.excludeFromContext) return "";
			label = "Shell output";
			body = typeof value.output === "string" ? value.output : "";
			if (value.truncated) sourceWarning = "[Source result truncated; missing output is not recovered.]";
			break;
		case "custom":
			if (!value.display || value.customType === "session-reference" || value.customType === "subagent-mention") return "";
			label = "Context";
			body = textContent(value.content);
			break;
		default:
			return "";
	}
	if (sourceWarning) {
		// Reserve the warning before clipping output. Its position also keeps it
		// ahead of any retained shell body when the source or total budget clips.
		const heading = `${label}: ${sourceWarning}\n`;
		return heading + boundedText(body, 8000 - Buffer.byteLength(heading));
	}
	return body.trim() ? boundedText(`${label}: ${body}`, 8000) : "";
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => block?.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}
