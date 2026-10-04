import type { Component } from "@earendil-works/pi-tui";

/**
 * A component built from a width-dependent line builder.
 *
 * The builder runs once per width and the result is cached until `invalidate()`.
 * The owning renderer decides when content, theme or expansion changed, so a
 * stale card cannot hide behind the cache. Non-positive widths are reported as
 * `1` so a builder never has to defend itself.
 */
export class RenderLines implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private readonly build: (width: number) => string[]) {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (this.cachedWidth !== safeWidth || !this.cachedLines) {
			this.cachedWidth = safeWidth;
			this.cachedLines = this.build(safeWidth);
		}
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
