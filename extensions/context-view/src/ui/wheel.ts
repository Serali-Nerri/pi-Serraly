/**
 * Mouse-wheel input shared by the Usage and Injections views.
 *
 * Views consume public normalized mouse events in fullscreen mode. This parser
 * also accepts raw reports passed to handleInput; regular mode keeps the wheel
 * for the terminal's native scrollback.
 */

/** Fixed raw-report fallback; normalized mouse events carry their own logical line delta. */
export const DEFAULT_WHEEL_SCROLL_LINES = 3;

/** SGR wheel report: `ESC [ < button ; column ; row` closed by `M` or `m`. */
const SGR_WHEEL_PATTERN = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;

/** Legacy X10 wheel report: `ESC [ M` plus offset-encoded button, column, and row bytes. */
const X10_PREFIX = "\x1b[M";
const X10_LENGTH = 6;
const X10_BUTTON_INDEX = 3;
const X10_BYTE_OFFSET = 32;

/** Wheel reports set this button bit; the low two bits then carry axis and direction. */
const WHEEL_BUTTON_BIT = 64;
const DIRECTION_MASK = 3;

/** One notch backwards (up) or forwards (down). */
export type WheelDirection = -1 | 1;

/**
 * Vertical wheel direction encoded in one input chunk, or undefined for every
 * other input, including horizontal notches. Modifier bits are ignored, so a
 * modified notch scrolls like a plain one, as it does in pi's own viewport.
 */
export function parseWheelDirection(data: string): WheelDirection | undefined {
	const sgrButton = SGR_WHEEL_PATTERN.exec(data)?.[1];
	if (sgrButton !== undefined) return decodeWheelButton(Number.parseInt(sgrButton, 10));
	if (data.length === X10_LENGTH && data.startsWith(X10_PREFIX)) {
		return decodeWheelButton(data.charCodeAt(X10_BUTTON_INDEX) - X10_BYTE_OFFSET);
	}
	return undefined;
}

/** Decode one button code, rejecting non-wheel buttons and the horizontal axis. */
function decodeWheelButton(button: number): WheelDirection | undefined {
	if ((button & WHEEL_BUTTON_BIT) === 0) return undefined;
	const direction = button & DIRECTION_MASK;
	if (direction === 0) return -1;
	if (direction === 1) return 1;
	return undefined;
}
