import type { TuiMouseEvent } from "@earendil-works/pi-tui";

/** Public Pi TUI wheel event: logical lines, not raw host internals. */
export function wheelEvent(wheelDelta: number): TuiMouseEvent {
	return { type: "wheel", button: "none", x: 0, y: 0, screenX: 0, screenY: 0,
		width: 80, height: 24, shift: false, alt: false, ctrl: false, wheelDelta };
}
