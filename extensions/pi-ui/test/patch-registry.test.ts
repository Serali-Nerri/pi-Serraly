// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
import assert from "node:assert/strict";
import test from "node:test";

import {
	ForeignPatchError, PatchRegistry, UI_PATCH_OWNER, brandOwned, isOwnedPatch, patchRegistry, slotName,
} from "../src/compat/patch-keys.ts";

test("dispose only deletes when still owned; ensure initializes once", () => {
	const registry = new PatchRegistry({});
	const key = Symbol("dispose");
	const stale = { id: "stale" };
	const current = { id: "current" };

	registry.install(key, stale);
	registry.install(key, current);
	assert.equal(registry.dispose(key, stale), false);
	assert.equal(registry.get(key), current);
	assert.equal(registry.dispose(key, current), true);
	assert.equal(registry.get(key), undefined);

	const ensureKey = Symbol("ensure");
	let inits = 0;
	const first = registry.ensure(ensureKey, () => {
		inits++;
		return { value: inits };
	});
	assert.equal(
		registry.ensure(ensureKey, () => ({ value: 99 })),
		first,
	);
	assert.equal(inits, 1);
});

test("owned install brands the value, hands over an owned predecessor and refuses a foreign one", () => {
	const registry = new PatchRegistry({});
	const key = Symbol("owned");
	type Shape = { kind: string };
	const accepts = (value: unknown): value is Shape =>
		typeof value === "object" && value !== null && typeof (value as Shape).kind === "string";
	const first = { kind: "first" };
	assert.equal(registry.installOwned(key, first), undefined);
	assert.equal(isOwnedPatch(first), true);
	assert.equal((first as Record<PropertyKey, unknown>)[UI_PATCH_OWNER], true);
	assert.equal(Object.keys(first).includes(String(UI_PATCH_OWNER)), false, "the brand is not enumerable");
	const second = { kind: "second" };
	assert.equal(registry.installOwned(key, second), first, "the owned predecessor is handed back");
	assert.equal(registry.getOwned(key, accepts), second);
	assert.equal(registry.getOwned(key, (value): value is { nope: true } =>
		typeof value === "object" && value !== null && "nope" in value), undefined, "shape mismatch is not owned");
	const foreign = { kind: "foreign" };
	registry.install(key, foreign);
	assert.equal(registry.getOwned(key, accepts), undefined, "an unmarked value is never returned as owned");
	assert.throws(() => registry.installOwned(key, { kind: "third" }), ForeignPatchError);
	assert.equal(registry.get(key), foreign, "the foreign value is untouched");
	assert.equal(registry.dispose(key, foreign), true, "an explicit identity dispose still works");
	assert.equal(brandOwned(first), first, "branding is idempotent");
	assert.equal(slotName(key), "owned", "diagnostics use the symbol description");
});

test("accessor, non-writable and frozen slots fail closed without executing a getter", () => {
	const registry = new PatchRegistry({});
	const accessor = Symbol("accessor");
	let getterCalls = 0;
	Object.defineProperty(registry.host, accessor, {
		configurable: true,
		get() { getterCalls++; return { kind: "x" }; },
	});
	assert.equal(registry.get(accessor), undefined);
	assert.equal(registry.getOwned(accessor, (value): value is { kind: string } => typeof value === "object" && value !== null), undefined);
	assert.throws(() => registry.installOwned(accessor, { kind: "x" }), ForeignPatchError);
	assert.equal(getterCalls, 0, "no descriptor read executes the getter");

	const fixed = Symbol("fixed");
	Object.defineProperty(registry.host, fixed, { value: { kind: "x" }, writable: false, configurable: false });
	assert.throws(() => registry.installOwned(fixed, { kind: "y" }), ForeignPatchError);
	assert.throws(() => registry.installOwned(Symbol("fresh"), Object.freeze({})), ForeignPatchError);
});

test("singleton storage is globalThis", () => {
	const key = Symbol.for("claude-style-tools.test.patch-registry");
	try {
		patchRegistry.install(key, { tag: "via-registry" });
		assert.equal(
			(globalThis as unknown as Record<PropertyKey, { tag: string }>)[key].tag,
			"via-registry",
		);
		(globalThis as Record<PropertyKey, unknown>)[key] = { tag: "via-globalThis" };
		assert.equal(patchRegistry.get<{ tag: string }>(key)?.tag, "via-globalThis");
	} finally {
		patchRegistry.delete(key);
	}
});
