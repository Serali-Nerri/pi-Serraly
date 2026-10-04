// Adapted from pi-cc-extensions v0.8.69; see licenses/claude-style-tools-THIRD_PARTY_NOTICES.md.
/**
 * ccstyle 补丁所有权与跨模块协调键的单一来源（single source of truth）。
 *
 * 全部使用 Symbol.for（全局注册表）：/reload 后新模块实例拿到的是同一个 symbol，
 * 这是跨 reload 识别/让渡补丁所有权的关键。切勿把这些 Symbol.for 改成模块局部 Symbol。
 *
 * 两类用途：
 * 1. globalThis 槽位：安装补丁时写 host[KEY] = patch，dispose 时按所有权判断还原。
 * 2. 实例/函数标记：把补丁包装器或组件实例标记在某个 symbol 属性上，供跨模块识别。
 *
 * PatchRegistry 把第 1 类的读写收口为带所有权语义的 install/dispose 生命周期；
 * 底层仍是 globalThis[symbol]，因此外部（含测试）直接读 globalThis 槽不受影响。
 */

// ── compact / compact-thinking 协调 ──
export const COMPACT_MODE_PATCH_KEY = Symbol.for("claude-style-tools.compact-mode-patch");
export const COMPACT_THINKING_PATCH_KEY = Symbol.for("claude-style-tools.compact-thinking-update");
export const PROTOTYPE_ORIGINAL_KEY = Symbol.for("claude-style-tools.prototype-original");
export const COMPACT_THINKING_OWNER = Symbol.for("claude-style-tools.compact-thinking-owner");

// ── assistant 展开状态（实例标记） ──
export const ASSISTANT_SET_EXPANDED_KEY = Symbol.for("claude-style-tools.compact-assistant-set-expanded");
export const ASSISTANT_TOGGLE_ROUND_KEY = Symbol.for("claude-style-tools.compact-assistant-toggle-round");
export const ASSISTANT_REENTRY_KEY = Symbol.for("claude-style-tools.compact-assistant-reentry");

// ── 工具渲染补丁 ──
export const GLOBAL_TOOL_RENDER_PATCH = Symbol.for("claude-style-tools.global-tool-render-patch");
export const COMPONENT_TOOL_RENDER_MODE = Symbol.for("claude-style-tools.component-tool-render-mode");
export const TOOL_EXPANDED_BACKGROUND_PATCH = Symbol.for(
	"claude-style-tools.tool-expanded-background-patch",
);

// ── 消息组件补丁 ──
export const MESSAGE_DISPLAY_PATCH = Symbol.for("claude-style-tools.message-display-patch");

// ── 工具分组 ──
export const TOOL_GROUPING_PATCH_KEY = Symbol.for("claude-style-tools.tool-grouping-patch");
export const TOOL_GROUPING_PARENT_KEY = Symbol.for("claude-style-tools.tool-grouping-parent");
export const TOOL_GROUPING_GENERATION_KEY = Symbol.for("claude-style-tools.tool-grouping-generation");

// ── 自有 owner 槽位（由 PatchRegistry 安装/释放） ──
export const UI_LIFECYCLE_OWNER = Symbol.for("pi-ui.lifecycle-owner");
export const TRANSCRIPT_OWNER = Symbol.for("claude-style-tools.rendering-owner");
export const NATIVE_MOUSE_OWNER = Symbol.for("claude-style-tools.native-mouse");

/**
 * 全部自有所有权槽位。只允许本模块写入的品牌值；未标记的值（即使带
 * dispose/stop 或形状相似）是 foreign，不接管、不覆盖、不释放。
 */
export const OWNERSHIP_SLOTS: readonly symbol[] = [
	COMPACT_MODE_PATCH_KEY, COMPACT_THINKING_OWNER, GLOBAL_TOOL_RENDER_PATCH,
	TOOL_EXPANDED_BACKGROUND_PATCH, MESSAGE_DISPLAY_PATCH, TOOL_GROUPING_PATCH_KEY,
	UI_LIFECYCLE_OWNER, NATIVE_MOUSE_OWNER, TRANSCRIPT_OWNER,
];

/**
 * 自有补丁品牌。只有本模块写入的 owner/pipeline 带它，因此一个带 dispose/stop
 * 的未标记对象不会被误认为可接管的上一代补丁。
 */
export const UI_PATCH_OWNER = Symbol.for("pi-serraly.ui.patch-owner");

/** 槽位名（Symbol 描述即上游槽位名），用于诊断与通知。 */
export function slotName(key: symbol): string {
	return key.description ?? "unknown-slot";
}

/** A foreign patch owns a slot this module refuses to touch. */
export class ForeignPatchError extends Error {
	readonly slot: string;

	constructor(slot: string, others: readonly string[] = []) {
		const all = [slot, ...others];
		super(`foreign patch owns ${all.join(", ")}; pi-ui leaves it untouched`);
		this.name = "ForeignPatchError";
		this.slot = slot;
	}
}

/** 是否为本模块写入的品牌值。只读品牌，不执行任何 getter。 */
export function isOwnedPatch(value: unknown): boolean {
	return typeof value === "object" && value !== null && (value as Record<PropertyKey, unknown>)[UI_PATCH_OWNER] === true;
}

/** 品牌写入。不可扩展对象无法标记，按 foreign 处理（fail closed）。 */
export function brandOwned<T extends object>(value: T): T {
	if (isOwnedPatch(value)) return value;
	if (!Object.isExtensible(value)) throw new ForeignPatchError("a non-extensible patch object");
	Object.defineProperty(value, UI_PATCH_OWNER, { value: true, enumerable: false, configurable: false, writable: false });
	return value;
}

// ── PatchRegistry：所有权生命周期统一收口 ──

/**
 * host 上的补丁槽位读写器。把散落各处的
 * `host[KEY] = patch` / `if (host[KEY] === patch) delete host[KEY]` 收口为
 * 带所有权语义的 install/dispose 生命周期：
 *
 * - install：覆盖写入并返回被替换的旧值（不自动让旧值失效——部分安装器
 *   需要先读旧补丁以链接下游方法，由调用方决定如何 inactivate）。
 * - dispose：所有权守卫删除——仅当槽位仍 === 该值才删除，防止 /reload 后
 *   旧模块误删新模块的补丁。
 * - owns：判断槽位是否仍由某值持有（恒等比较）。
 * - ensure：惰性状态槽（??= 语义），用于无所有权的跨模块共享状态。
 */
export class PatchRegistry {
	readonly host: Record<PropertyKey, unknown>;

	constructor(
		host: Record<PropertyKey, unknown> = globalThis as unknown as Record<PropertyKey, unknown>,
	) {
		this.host = host;
	}

	/**
	 * 槽位描述符。读取只用 descriptor，绝不执行外部 getter：一个访问器槽位
	 * 无法验证所有权，因此按 foreign 处理。
	 */
	descriptor(key: symbol): PropertyDescriptor | undefined {
		return Object.getOwnPropertyDescriptor(this.host, key);
	}

	/** 读取槽位当前值；访问器槽位返回 undefined，不执行 getter。 */
	get<T = unknown>(key: symbol): T | undefined {
		const descriptor = this.descriptor(key);
		if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return undefined;
		return descriptor.value as T | undefined;
	}

	/** 是否仍由 value 持有（恒等比较，不执行 getter）。 */
	owns(key: symbol, value: unknown): boolean {
		return this.get(key) === value;
	}

	/** 覆盖写入并返回被替换的旧值；不自动让旧值失效。 */
	install<T = unknown>(key: symbol, value: T): T | undefined {
		const previous = this.get<T>(key);
		this.host[key] = value;
		return previous;
	}

	/**
	 * 槽位值仅当它由本模块写入且满足调用方的形状断言时返回；foreign、malformed
	 * 与访问器槽位都返回 undefined，调用方随后由 installOwned 拒绝安装。
	 */
	getOwned<T extends object>(key: symbol, accepts: (value: unknown) => value is T): T | undefined {
		const value = this.get(key);
		return isOwnedPatch(value) && accepts(value) ? value : undefined;
	}

	/**
	 * 品牌后安装。槽位里的 foreign 值（或不可写/访问器槽位）直接抛错，绝不覆盖
	 * 或调用它；被替换的自有旧值原样返回，由调用方决定如何失效（不自动 dispose）。
	 */
	installOwned<T extends object>(key: symbol, value: T): T | undefined {
		const descriptor = this.descriptor(key);
		if (descriptor !== undefined) {
			if (descriptor.get !== undefined || descriptor.set !== undefined) throw new ForeignPatchError(slotName(key));
			if (descriptor.writable === false) throw new ForeignPatchError(slotName(key));
			const previous = descriptor.value;
			if (previous !== undefined && previous !== null && !isOwnedPatch(previous)) throw new ForeignPatchError(slotName(key));
			this.host[key] = brandOwned(value);
			return isOwnedPatch(previous) ? (previous as T) : undefined;
		}
		this.host[key] = brandOwned(value);
		return undefined;
	}

	/** 所有权守卫删除：仅当槽位仍 === value 时删除。返回是否删除。 */
	dispose(key: symbol, value: unknown): boolean {
		const descriptor = this.descriptor(key);
		if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return false;
		if (descriptor.value !== value) return false;
		if (descriptor.configurable === false) return false;
		delete this.host[key];
		return true;
	}

	/** 惰性槽位：无值（null/undefined）时用 init() 初始化并缓存。 */
	ensure<T>(key: symbol, init: () => T): T {
		const current = this.get<T>(key);
		if (current !== null && current !== undefined) return current;
		const value = init();
		this.host[key] = value;
		return value;
	}

	/** 无条件删除槽位（不判断所有权）。返回是否实际删除了键。 */
	delete(key: symbol): boolean {
		const descriptor = this.descriptor(key);
		if (descriptor === undefined || descriptor.configurable === false) return false;
		delete this.host[key];
		return true;
	}
}

/** 全局单例：host 固定为 globalThis，跨 /reload 与 jiti 重载稳定。 */
export const patchRegistry = new PatchRegistry();
