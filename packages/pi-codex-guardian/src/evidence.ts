import { isRecord, ReviewFailure, serializeReview } from "./review.js";

export interface EvidenceItem {
	kind: "constraint" | "user" | "assistant" | "tool";
	text: string;
	truncated?: true;
}

export interface ParentEvidence {
	instructions: string;
	items: EvidenceItem[];
	omitted: number;
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) throw new ReviewFailure("context");
	return content
		.map((part: unknown) => {
			if (
				!isRecord(part) ||
				!["input_text", "output_text", "text"].includes(String(part["type"])) ||
				typeof part["text"] !== "string"
			)
				throw new ReviewFailure("context");
			return part["text"];
		})
		.join("\n");
}

/** The prepared Responses request is the authorization boundary, not session history. */
export function projectEvidence(
	payload: Record<string, unknown>,
): ParentEvidence {
	const input = payload["input"];
	if (
		!Array.isArray(input) ||
		payload["previous_response_id"] ||
		(payload["instructions"] !== undefined &&
			typeof payload["instructions"] !== "string")
	)
		throw new ReviewFailure("context");
	const items: EvidenceItem[] = [];
	for (const item of input as unknown[]) {
		if (!isRecord(item)) throw new ReviewFailure("context");
		if (item["type"] === "reasoning" || item["type"] === "additional_tools")
			continue;
		if (item["type"] === "configuration_update") {
			items.push({ kind: "constraint", text: JSON.stringify(item) });
			continue;
		}
		const role = item["role"];
		if (
			role === "system" ||
			role === "developer" ||
			role === "user" ||
			role === "assistant"
		) {
			items.push({
				kind: role === "system" || role === "developer" ? "constraint" : role,
				text: textContent(item["content"]),
			});
		} else if (
			item["type"] === "function_call" ||
			item["type"] === "custom_tool_call"
		) {
			items.push({
				kind: "tool",
				text: JSON.stringify({
					type: item["type"],
					name: item["name"],
					call_id: item["call_id"],
					arguments: item["arguments"],
					input: item["input"],
				}),
			});
		} else if (
			item["type"] === "function_call_output" ||
			item["type"] === "custom_tool_call_output"
		) {
			const output = item["output"];
			items.push({
				kind: "tool",
				text: JSON.stringify({
					type: item["type"],
					call_id: item["call_id"],
					output: textContent(isRecord(output) ? output["content"] : output),
				}),
			});
		} else {
			// Includes opaque checkpoints, item references and unsupported modalities.
			throw new ReviewFailure("context");
		}
	}
	let remaining = 40;
	const budgets = { assistant: 20_000, tool: 10_000 };
	const selected: EvidenceItem[] = [];
	let omitted = 0;
	for (const item of items.reverse()) {
		if (item.kind === "constraint" || item.kind === "user") {
			selected.push(item);
			continue;
		}
		const limit = Math.min(
			item.kind === "tool" ? 1_000 : 5_000,
			budgets[item.kind],
		);
		if (remaining === 0 || limit === 0) {
			omitted++;
			continue;
		}
		const bytes = Buffer.from(item.text, "utf8");
		const truncated = bytes.length > limit;
		selected.push(
			truncated
				? {
						...item,
						text: bytes
							.subarray(0, limit)
							.toString("utf8")
							.replace(/\uFFFD$/, ""),
						truncated: true,
					}
				: item,
		);
		budgets[item.kind] -= Math.min(bytes.length, limit);
		remaining--;
	}
	const evidence = {
		instructions: (payload["instructions"] as string | undefined) ?? "",
		items: selected.reverse(),
		omitted,
	};
	// Mandatory authorization alone can exceed the local review budget.
	serializeReview({
		instructions: evidence.instructions,
		items: evidence.items.filter(
			(item) => item.kind === "constraint" || item.kind === "user",
		),
	});
	return evidence;
}
