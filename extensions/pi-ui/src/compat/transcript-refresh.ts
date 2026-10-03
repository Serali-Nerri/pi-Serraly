// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { walkComponentTree } from "./component-tree.ts";
import { COMPACT_MODE_PATCH_KEY, patchRegistry } from "./patch-keys.ts";
import { isMessageDisplayComponent } from "./message-display.ts";

// pi-coding-agent 类型声明中 AssistantMessageComponent 仅能以 value 形式使用，
// updateContent/lastMessage 用结构化类型访问。
type TranscriptComponentInternals = {
	lastMessage?: AssistantMessage;
	updateContent(message: AssistantMessage): void;
	invalidate?(): void;
};

/**
 * 重绘单个已构造的组件：assistant 用最新消息重渲染（compact thinking），
 * tool 强制 updateDisplay（其内容可能仍在旧 shell 容器中），
 * skill/压缩/分支摘要 invalidate 重走已安装的 updateDisplay（模式切换后
 * 重绘 ccstyle 或还原原生外壳）。
 * 不吞异常——由调用方决定如何处理失败。
 */
export function refreshTranscriptComponent(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (isMessageDisplayComponent(value)) {
		(value as { invalidate?(): void }).invalidate?.();
		return true;
	}
	if (value instanceof AssistantMessageComponent) {
		const self = value as unknown as TranscriptComponentInternals;
		if (self.lastMessage) self.updateContent(self.lastMessage);
		else self.invalidate?.();
		return true;
	}
	if (value instanceof ToolExecutionComponent) {
		// updateDisplay 是私有方法，但它是 resume 后让内容回到正确
		// shell 容器的唯一入口（原型链已含全局工具渲染补丁）。
		(value as unknown as { updateDisplay(): void }).updateDisplay();
		return true;
	}
	return false;
}

/**
 * 扫描挂载树，重绘所有已构造的 assistant/tool/摘要组件。
 * 用于 reload/resume/compaction 后"pi 用原始原型重建、补丁事后才装"的场景。
 * 遍历 value.children 与 value.getMountedRoots?.()（seen 集合防环），
 * 单个组件失败用 try/catch 隔离，不影响其余组件。
 */

/**
 * 补丁链序不变量：compact 模式下 compact-mode 必须位于 compact-thinking
 * 外层（round 摘要才能聚合工具统计）。resume/reload 后若无新消息，
 * message_update 触发的重新认领不会执行，这里在任何重绘前先断言一次。
 * 断言幂等：链序已正确时无操作；mode=on 时也安全（外层走 pass-through）。
 */
function assertCompactModeOutermost(): void {
	try {
		const patch = patchRegistry.get<{ assertAssistantOwnership?: () => void }>(
			COMPACT_MODE_PATCH_KEY,
		);
		if (patch && typeof patch.assertAssistantOwnership === "function") {
			patch.assertAssistantOwnership();
		}
	} catch {
		// 无 compact-mode 补丁或断言失败时跳过，扫描仍会执行。
	}
}

export function refreshMountedTranscript(tui?: unknown): void {
	if (!tui || typeof (tui as any).getMountedRoots !== "function") return;
	// 先修正链序再重绘：扫描触发 updateContent 时 compact-mode 已在外层。
	assertCompactModeOutermost();
	walkComponentTree(tui, (value: any) => {
		try {
			refreshTranscriptComponent(value);
		} catch {
			// 单个组件失败不阻断其余组件；后续 session_tree/重绘再试。
		}
	});
}

/** Track native transcript object identities, not display-only child rebuilds.
 * The bridge compares these only while awaiting the host's compaction rebuild.
 */
export function mountedTranscriptIdentity(tui?: unknown): Set<object> {
	const components = new Set<object>();
	if (!tui || typeof (tui as any).getMountedRoots !== "function") return components;
	walkComponentTree(tui, (value: any) => {
		if (value instanceof AssistantMessageComponent || value instanceof ToolExecutionComponent ||
			isMessageDisplayComponent(value)) components.add(value);
	});
	return components;
}

export function mountedTranscriptChanged(before: Set<object>, tui?: unknown): boolean {
	const current = mountedTranscriptIdentity(tui);
	return before.size !== current.size || [...current].some((value) => !before.has(value));
}
