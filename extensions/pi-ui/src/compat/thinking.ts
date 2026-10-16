// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
// Pi 1.3.0: decorate hidden thinking runs, never fork the host's message renderer.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
import { COMPACT_THINKING_PATCH_KEY } from "./patch-keys.ts";
import { captureMethod, installMethodStep } from "./method-pipeline.ts";
import { requireReplaceableMethod } from "./host-capabilities.ts";

type Assistant = InstanceType<typeof AssistantMessageComponent>;
type Internals = {
	contentContainer: { children: Component[] };
	hideThinkingBlock: boolean;
	thinkingVisibilityOverrides: Map<number, boolean>;
	hiddenThinkingLabel: string;
	outputPad: number;
	lastMessage?: AssistantMessage;
};

export type ThinkingRun = { start: number; end: number; padding: number; hiddenLabel: string };
export type ThinkingPatch = {
	refreshActive(message?: AssistantMessage): void;
	clearActive(): void;
	dispose(): void;
};

export function installThinkingPatch(options: {
	isActive(messageTimestamp: number): boolean;
	isActiveRun(messageTimestamp: number, start: number, end: number): boolean;
	preview(message: AssistantMessage, run: ThinkingRun): Component;
}): ThinkingPatch {
	const prototype = AssistantMessageComponent.prototype;
	requireReplaceableMethod("AssistantMessageComponent", prototype, "updateContent");
	const original = captureMethod(prototype, "updateContent") as typeof prototype.updateContent;
	let installed = true;
	let latest: Assistant | undefined;
	const streaming = new Set<Assistant>();

	const wrapper: typeof original = function (this: Assistant, message, isStreaming) {
		if (!installed) return original.call(this, message, isStreaming);
		const self = this as unknown as Internals;
		latest = this;
		if (options.isActive(message.timestamp)) streaming.add(this);
		// Native Pi skips empty thinking. Supply a display-only sentinel so it
		// reserves exactly the same spacing and run visibility as nonempty text.
		const runs: Array<{ start: number; end: number }> = [];
		let displayMessage = message;
		for (let index = 0; index < message.content.length; index++) {
			if (message.content[index].type !== "thinking") continue;
			const start = index;
			let nonempty = false;
			while (index < message.content.length && message.content[index].type === "thinking") {
				const block = message.content[index];
				if (block.type === "thinking" && block.thinking.trim()) nonempty = true;
				index++;
			}
			const end = --index;
			if (!nonempty && options.isActiveRun(message.timestamp, start, end) && (self.thinkingVisibilityOverrides.get(runs.length) ?? self.hideThinkingBlock)) {
				const content = [...displayMessage.content];
				content[start] = { ...content[start], type: "thinking", thinking: "\u200b" } as typeof content[number];
				displayMessage = { ...message, content };
				nonempty = true;
			}
			if (nonempty) runs.push({ start, end });
		}
		original.call(this, displayMessage, isStreaming);
		self.lastMessage = message;
		// Pi 1.3.0 wraps every thinking run in MouseRegion. Leave visible
		// Markdown, per-run native expansion, text transforms, errors and OSC
		// zones untouched. Our preview's existing mouse interaction owns hidden runs.
		let runIndex = 0;
		for (let index = 0; index < self.contentContainer.children.length; index++) {
			const child = self.contentContainer.children[index];
			// Structural match also works when the host resolves its nested TUI
			// dependency separately from the extension during workspace tests.
			if (!("child" in child) || !("onMouse" in child) || typeof child.onMouse !== "function") continue;
			const run = runs[runIndex];
			const hidden = self.thinkingVisibilityOverrides.get(runIndex++) ?? self.hideThinkingBlock;
			if (!run || !hidden) continue;
			self.contentContainer.children[index] = options.preview(message, {
				...run, padding: self.outputPad, hiddenLabel: self.hiddenThinkingLabel,
			});
		}
	};
	(wrapper as unknown as Record<symbol, unknown>)[COMPACT_THINKING_PATCH_KEY] = true;
	const step = installMethodStep(prototype, "updateContent", () => wrapper);

	return {
		refreshActive(message) {
			if (!installed) return;
			if (latest && message && (latest as unknown as Internals).lastMessage?.timestamp === message.timestamp) {
				streaming.add(latest);
				latest.updateContent(message);
			}
			for (const component of streaming) {
				const last = (component as unknown as Internals).lastMessage;
				if (last) component.updateContent(last);
			}
		},
		clearActive() { streaming.clear(); },
		dispose() {
			if (!installed) return;
			installed = false;
			streaming.clear();
			latest = undefined;
			step.dispose();
		},
	};
}
