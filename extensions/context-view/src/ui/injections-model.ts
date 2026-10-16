/**
 * Pure presentation model for the Injections view: flattened rows and
 * list navigation/scrolling state. No pi or TUI access — unit-testable.
 */
import type { RequestSnapshot, InjectionChange, InjectionItem } from "../model.ts";

/** One flattened list row derived from the snapshot hierarchy. */
export type InjectionRow =
	| {
		readonly kind: "group";
		readonly label: string;
		readonly tokens: number;
		readonly depth: 0;
	}
	| {
		readonly kind: "item";
		readonly label: string;
		readonly tokens: number;
		/** One for items and two for constituent sub-items. */
		readonly depth: 1 | 2;
		/** Whether this row is the final sibling at its depth. */
		readonly isLast: boolean;
		/** Whether a depth-two row's parent has a following sibling. */
		readonly parentContinues?: boolean;
		/** Whether a `--system-prompt` replacement dropped this contribution. */
		readonly dropped?: boolean;
		/** Whether an extension moved this part out of the region pi renders it into. */
		readonly moved?: boolean;
		/** Stable preview target id from the snapshot. */
		readonly itemId: string;
		/** Line-level size of this contribution's latest-request change, when it differs. */
		readonly change?: InjectionChangeCounts;
	}
	| {
		readonly kind: "separator";
		readonly label: "";
		readonly tokens: 0;
		readonly depth: 0;
	}
	| {
		readonly kind: "total";
		readonly label: "TOTAL";
		readonly tokens: number;
		readonly depth: 0;
	};

/** Line-level size of an item's request-vs-session change. */
export interface InjectionChangeCounts {
	/** Lines the latest request added or changed. */
	readonly added: number;
	/** Lines the latest request removed or replaced. */
	readonly removed: number;
}

/** Trim common leading and trailing lines so only the changed middle remains. */
export function changedLines(change: InjectionChange): { readonly removed: string[]; readonly added: string[] } {
	const before = contentLines(change.before);
	const after = contentLines(change.after);
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	let end = 0;
	while (
		end < before.length - start &&
		end < after.length - start &&
		before[before.length - 1 - end] === after[after.length - 1 - end]
	) end++;
	return { removed: before.slice(start, before.length - end), added: after.slice(start, after.length - end) };
}

/** Count a change's differing lines, when one was recorded. */
export function countChangedLines(change: InjectionChange | undefined): InjectionChangeCounts | undefined {
	if (change === undefined) return undefined;
	const { removed, added } = changedLines(change);
	return { added: added.length, removed: removed.length };
}

function contentLines(text: string): string[] {
	return text === "" ? [] : text.split("\n");
}

/** Index snapshot items (including sub-items) by id for preview lookup. */
export function collectItemsById(snapshot: RequestSnapshot): Map<string, InjectionItem> {
	const items = new Map<string, InjectionItem>();
	for (const group of snapshot.groups) {
		for (const item of group.items) {
			items.set(item.id, item);
			for (const child of item.children ?? []) items.set(child.id, child);
		}
	}
	return items;
}

/** Flatten the request contribution tree; the view renders its total separately. */
export function buildInjectionRows(snapshot: RequestSnapshot): InjectionRow[] {
	const rows: InjectionRow[] = [];
	for (const group of snapshot.groups) {
		rows.push({
			kind: "group",
			label: group.source.label,
			tokens: group.totalTokens,
			depth: 0,
		});
		group.items.forEach((item, itemIndex) => {
			const isLastItem = itemIndex === group.items.length - 1;
			rows.push({
				kind: "item",
				label: item.label,
				tokens: item.tokens,
				depth: 1,
				isLast: isLastItem,
				dropped: item.dropped,
				moved: item.moved,
				itemId: item.id,
				change: countChangedLines(item.change),
			});
			const children = item.children ?? [];
			children.forEach((child, childIndex) => {
				rows.push({
					kind: "item",
					label: child.label,
					tokens: child.tokens,
					depth: 2,
					isLast: childIndex === children.length - 1,
					parentContinues: !isLastItem,
					dropped: child.dropped,
					moved: child.moved,
					itemId: child.id,
					change: countChangedLines(child.change),
				});
			});
		});
	}
	return rows;
}

/**
 * Selection and scroll-window state over fixed rows. A trailing summary can
 * participate in scrolling without being included in selection navigation.
 */
export class ListNavigator {
	private readonly rowCount: number;
	private readonly selectableRowCount: number;
	private visibleCount: number;
	private selectedIndex = 0;
	private scrollOffset = 0;

	public constructor(rowCount: number, visibleCount: number, selectableRowCount = rowCount) {
		this.rowCount = Math.max(0, rowCount);
		this.selectableRowCount = Math.min(this.rowCount, Math.max(0, selectableRowCount));
		this.visibleCount = Math.max(1, visibleCount);
	}

	public get selected(): number {
		return this.selectedIndex;
	}

	public get selectedOrdinal(): number {
		return this.selectedIndex;
	}

	public get selectableCount(): number {
		return this.selectableRowCount;
	}

	public get offset(): number {
		return this.scrollOffset;
	}

	public get windowSize(): number {
		return Math.min(this.visibleCount, this.rowCount);
	}

	/** One-based final row currently visible, suitable for a scroll counter. */
	public get visibleEnd(): number {
		return Math.min(this.rowCount, this.scrollOffset + this.windowSize);
	}

	public get hasOverflow(): boolean {
		return this.rowCount > this.visibleCount;
	}

	public setVisibleCount(count: number): void {
		this.visibleCount = Math.max(1, count);
		this.ensureVisible();
	}

	public moveBy(delta: number): boolean {
		return this.moveTo(this.selectedIndex + delta);
	}

	public moveTo(index: number): boolean {
		if (this.selectableRowCount === 0) return false;
		const next = Math.min(this.selectableRowCount - 1, Math.max(0, index));
		if (next === this.selectedIndex) return false;
		this.selectedIndex = next;
		this.ensureVisible();
		return true;
	}

	public page(direction: -1 | 1): boolean {
		return this.moveBy(direction * Math.max(1, this.visibleCount - 1));
	}

	private ensureVisible(): void {
		const maxOffset = Math.max(0, this.rowCount - this.visibleCount);
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + this.visibleCount) {
			this.scrollOffset = this.selectedIndex - this.visibleCount + 1;
		}

		const trailingRows = this.rowCount - this.selectedIndex - 1;
		if (this.selectedIndex === this.selectableRowCount - 1 && trailingRows < this.visibleCount) {
			this.scrollOffset = maxOffset;
		}
		this.scrollOffset = Math.min(maxOffset, Math.max(0, this.scrollOffset));
	}
}

/**
 * Scroll-only window over wrapped preview lines. Extent is re-declared each
 * render (wrapping depends on width); the offset is clamped to stay valid.
 */
export class PreviewScroller {
	private lineCount = 0;
	private visibleCount = 1;
	private offsetValue = 0;

	public get offset(): number {
		return this.offsetValue;
	}

	public get windowSize(): number {
		return Math.min(this.visibleCount, this.lineCount);
	}

	/** One-based final line currently visible, suitable for a progress counter. */
	public get visibleEnd(): number {
		return Math.min(this.lineCount, this.offsetValue + this.windowSize);
	}

	public get hasOverflow(): boolean {
		return this.lineCount > this.visibleCount;
	}

	public get maxOffset(): number {
		return Math.max(0, this.lineCount - this.visibleCount);
	}

	public setExtent(lineCount: number, visibleCount: number): void {
		this.lineCount = Math.max(0, lineCount);
		this.visibleCount = Math.max(1, visibleCount);
		this.offsetValue = Math.min(this.maxOffset, this.offsetValue);
	}

	public scrollBy(delta: number): boolean {
		return this.scrollTo(this.offsetValue + delta);
	}

	public scrollTo(offset: number): boolean {
		const next = Math.min(this.maxOffset, Math.max(0, offset));
		if (next === this.offsetValue) return false;
		this.offsetValue = next;
		return true;
	}

	public page(direction: -1 | 1): boolean {
		return this.scrollBy(direction * Math.max(1, this.visibleCount - 1));
	}

	public reset(): void {
		this.offsetValue = 0;
	}
}
