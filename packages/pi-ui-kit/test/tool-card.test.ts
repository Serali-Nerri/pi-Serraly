import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	renderToolHeader,
	renderToolStatus,
	toolHeaderText,
	toolStatusText,
	type ToolCardColor,
} from "../src/tool-card.ts";

/** A theme that leaves text alone, for assertions about the literal line. */
const plainTheme = { fg: (_color: ToolCardColor, text: string) => text, bold: (text: string) => text };

/** Records which theme roles were asked for, so a state must not be colour-only. */
function recordingTheme() {
	const roles: ToolCardColor[] = [];
	return {
		roles,
		fg: (color: ToolCardColor, text: string) => { roles.push(color); return `<${color}>${text}</${color}>`; },
		bold: (text: string) => `*${text}*`,
	};
}

describe("renderToolHeader", () => {
	it("renders one line with the title and summary", () => {
		const lines = renderToolHeader(recordingTheme(), { title: "read", summary: "src/config.ts", state: "running" }, 80);
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /\*<toolTitle>read<\/toolTitle>\*/);
		assert.match(lines[0]!, /<muted>src\/config\.ts<\/muted>/);
	});

	it("omits an absent or empty summary", () => {
		for (const summary of [undefined, "", "   "]) {
			const line = renderToolHeader(plainTheme, { title: "bash", summary }, 80)[0]!;
			assert.equal(line, "● bash");
		}
	});

	it("renders a caller-supplied glyph without owning the animation", () => {
		const line = renderToolHeader(plainTheme, { title: "write", glyph: "⠋" }, 40)[0]!;
		assert.equal(line, "⠋ write");
		assert.equal(renderToolHeader(plainTheme, { title: "write", glyph: "  " }, 40)[0], "● write",
			"an empty glyph falls back to the default dot");
	});

	it("uses a distinct semantic role for every state", () => {
		const roleOf = (state: Parameters<typeof renderToolHeader>[1]["state"]) => {
			const theme = recordingTheme();
			renderToolHeader(theme, { title: "x", state }, 40);
			return theme.roles[0];
		};
		const states = ["running", "success", "error", "cancelled", "neutral"] as const;
		const roles = states.map(roleOf);
		assert.deepEqual(roles, ["accent", "success", "error", "warning", "dim"]);
		assert.equal(new Set(roles).size, roles.length, "no two states share a colour");
		assert.equal(roleOf(undefined), "dim", "an unspecified state is neutral");
	});

	it("strips terminal control sequences and folds newlines before colouring", () => {
		const line = renderToolHeader(recordingTheme(), { title: "safe\u001b[2Jtitle", summary: "one\ntwo\tthree" }, 80)[0]!;
		assert.doesNotMatch(line, /\u001b\[2J/, "an injected control sequence never reaches the terminal");
		assert.doesNotMatch(line, /[\n\t]/, "the header is a single line");
		assert.match(line, /safetitle/);
		assert.match(line, /one two three/);
	});

	it("never exceeds the given visible width", () => {
		for (const width of [1, 8, 20, 40]) {
			const line = renderToolHeader(recordingTheme(), { title: "apply_patch", summary: "(a/very/long/path/to/a/file.txt)", state: "success" }, width)[0]!;
			assert.ok(visibleWidth(line) <= width, `width ${width} produced ${visibleWidth(line)} columns`);
		}
	});

	it("returns no line for a non-positive width", () => {
		assert.deepEqual(renderToolHeader(recordingTheme(), { title: "x" }, 0), []);
		assert.deepEqual(renderToolHeader(recordingTheme(), { title: "x" }, -5), []);
	});
});

describe("renderToolStatus", () => {
	it("renders one indented status line with the message text", () => {
		const lines = renderToolStatus(plainTheme, { state: "success", message: "Updated 2 files" }, 80);
		assert.equal(lines.length, 1);
		assert.equal(lines[0]!.replace(/\u001b\[[0-9;]*m/g, ""), "  ⎿ Updated 2 files");
	});

	it("carries the state in the message colour, not only in the glyph", () => {
		const roleOf = (state: Parameters<typeof renderToolStatus>[1]["state"]) => {
			const theme = recordingTheme();
			renderToolStatus(theme, { state, message: "done" }, 40);
			return theme.roles.at(-1);
		};
		const states = ["running", "success", "error", "cancelled", "neutral"] as const;
		assert.deepEqual(states.map(roleOf), ["accent", "success", "error", "warning", "muted"]);
	});

	it("strips control sequences, folds newlines and never exceeds the width", () => {
		const line = renderToolStatus(recordingTheme(), { state: "error", message: "boom\u001b[31m\nred" }, 12)[0]!;
		assert.doesNotMatch(line, /\u001b\[31m/);
		assert.doesNotMatch(line, /[\n\t]/);
		assert.ok(visibleWidth(line) <= 12);
	});

	it("returns no line for a non-positive width", () => {
		assert.deepEqual(renderToolStatus(recordingTheme(), { state: "neutral", message: "x" }, 0), []);
	});
});

describe("toolHeaderText / toolStatusText", () => {
	it("build the same card text without applying a width", () => {
		const value = { title: "apply_patch", summary: "(src/ · 3 changes)", state: "success" } as const;
		assert.equal(toolHeaderText(plainTheme, value), renderToolHeader(plainTheme, value, 200)[0]);
		assert.equal(
			toolStatusText(plainTheme, { state: "success", message: "1 added, 1 updated · +7 -5" }),
			"  ⎿ 1 added, 1 updated · +7 -5",
		);
	});

	it("still sanitizes the text builders", () => {
		const header = toolHeaderText(plainTheme, { title: "safe\u001b[2Jtitle", summary: "one\ntwo" });
		assert.doesNotMatch(header, /\u001b\[2J/);
		assert.equal(header, "● safetitle one two");
		const status = toolStatusText(plainTheme, { state: "error", message: "boom\u001b]0;t\u0007" });
		assert.doesNotMatch(status, /\u0007/);
		assert.equal(status, "  ⎿ boom");
	});

	it("keeps an owner-styled message untouched so multi-colour content survives", () => {
		const styled = "\u001b[32m5 uses\u001b[0m·3 turns";
		const line = toolStatusText(plainTheme, { state: "success", message: styled, styled: true });
		assert.ok(line.includes(styled));
		assert.match(line, /⎿ /);
		const line2 = toolStatusText(plainTheme, { state: "success", message: styled });
		assert.doesNotMatch(line2, /\u001b\[32m/, "an unstyled message is sanitized as plain text");
	});
});
