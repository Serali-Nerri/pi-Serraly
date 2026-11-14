import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A yielded tool can append results while review is pending. Boundary edits,
 * unlike ordinary results, can change authorization without message events. */
export function hasOnlyResultAppends(
	session: ExtensionContext["sessionManager"],
	fromLeaf: string | null,
): boolean {
	let cursor = session.getLeafId();
	while (cursor !== fromLeaf) {
		if (cursor === null) return false;
		const entry = session.getEntry(cursor);
		if (!entry) return false;
		switch (entry.type) {
			case "message":
				if (
					entry.message.role !== "assistant" &&
					entry.message.role !== "toolResult"
				)
					return false;
				break;
			case "custom":
			case "usage":
			case "label":
			case "session_info":
				break;
			default:
				return false;
		}
		cursor = entry.parentId;
	}
	return true;
}
