import assert from "node:assert/strict";
import { test } from "node:test";

import { parseWheelDirection } from "../src/ui/wheel.ts";

/** One X10 wheel report: `ESC [ M` plus offset-encoded button, column, and row bytes. */
function x10Report(button: number, column: number, row: number): string {
	return `\u001b[M${String.fromCharCode(button + 32, column + 33, row + 33)}`;
}

test("parseWheelDirection decodes vertical SGR and X10 notches only", () => {
	assert.equal(parseWheelDirection("\u001b[<64;20;5M"), -1);
	assert.equal(parseWheelDirection("\u001b[<65;20;5M"), 1);

	// Modifier bits and the release form still describe a plain vertical notch.
	assert.equal(parseWheelDirection("\u001b[<69;1;1M"), 1, "shift + wheel down");
	assert.equal(parseWheelDirection("\u001b[<80;1;1m"), -1, "ctrl + wheel up");

	assert.equal(parseWheelDirection(x10Report(64, 19, 4)), -1);
	assert.equal(parseWheelDirection(x10Report(65, 19, 4)), 1);

	// Horizontal notches, plain buttons, keys, and text are not vertical scrolling.
	assert.equal(parseWheelDirection("\u001b[<66;20;5M"), undefined, "wheel left");
	assert.equal(parseWheelDirection("\u001b[<67;20;5M"), undefined, "wheel right");
	assert.equal(parseWheelDirection("\u001b[<0;20;5M"), undefined, "left button press");
	assert.equal(parseWheelDirection(x10Report(0, 19, 4)), undefined);
	assert.equal(parseWheelDirection("\u001b[B"), undefined);
	assert.equal(parseWheelDirection("j"), undefined);
	assert.equal(parseWheelDirection(""), undefined);
	assert.equal(parseWheelDirection("\u001b[<64;20;5M\u001b[<64;20;5M"), undefined, "unsplit burst");
});
