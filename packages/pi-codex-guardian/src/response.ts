export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SuccessfulResponse {
	id: string;
	output: unknown;
}

/** Provider observers see raw terminal aliases before Pi normalizes them. */
export function parseSuccessfulResponseEvent(
	data: unknown,
): SuccessfulResponse | undefined {
	if (
		!isRecord(data) ||
		(data["type"] !== "response.completed" && data["type"] !== "response.done")
	)
		return;
	const response = data["response"];
	if (
		!isRecord(response) ||
		response["status"] !== "completed" ||
		typeof response["id"] !== "string" ||
		!/^resp_[a-zA-Z0-9]+$/.test(response["id"])
	)
		return;
	return { id: response["id"], output: response["output"] };
}
