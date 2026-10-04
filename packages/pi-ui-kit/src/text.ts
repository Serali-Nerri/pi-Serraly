import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Pad a line with spaces up to `width` visible columns.
 *
 * Wide characters count as their terminal columns. A line that is already at
 * least `width` columns wide is returned unchanged: padding never truncates.
 * A non-positive width returns an empty string.
 */
export function padToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	const current = visibleWidth(text);
	return current >= width ? text : text + " ".repeat(width - current);
}
