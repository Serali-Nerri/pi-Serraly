import assert from "node:assert/strict";
import test from "node:test";
import { METHOD_PIPELINE_KEY, captureMethod, installMethodStep } from "../src/compat/method-pipeline.ts";
import { isOwnedPatch } from "../src/compat/patch-keys.ts";

test("display steps share one wrapper, preserve order and release to the native method", () => {
	const original = () => "native";
	const proto = { method: original };
	const first = installMethodStep(proto, "method", (next) => function () { return `thinking(${next.call(this)})`; });
	const wrapper = proto.method;
	const captured = captureMethod(proto, "method");
	const second = installMethodStep(proto, "method", (next) => function () { return `compact(${next.call(this)})`; });
	assert.equal(proto.method, wrapper);
	assert.equal(proto.method(), "compact(thinking(native))");
	assert.equal(captured.call(proto), "thinking(native)");
	first.dispose();
	assert.equal(proto.method(), "compact(native)");
	second.dispose();
	assert.equal(proto.method, original);
	assert.equal(wrapper(), "native");
});

test("late disposal leaves a foreign wrapper intact and captured pipeline becomes inert", () => {
	const proto = { method: () => "native" };
	const patch = installMethodStep(proto, "method", (next) => function () { return `ui(${next.call(this)})`; });
	const captured = proto.method;
	const foreign = () => `foreign(${captured()})`;
	proto.method = foreign;
	patch.dispose();
	patch.dispose();
	assert.equal(proto.method, foreign);
	assert.equal(proto.method(), "foreign(native)");
});

test("an installed pipeline registry carries the ownership brand", () => {
	const proto = { method: () => "native" };
	const patch = installMethodStep(proto, "method", (next) => function () { return `ui(${next.call(this)})`; });
	try {
		assert.equal(isOwnedPatch((proto as any)[METHOD_PIPELINE_KEY]), true);
	} finally { patch.dispose(); }
	assert.equal(Object.hasOwn(proto, METHOD_PIPELINE_KEY), false, "the owned registry is removed again");
});

test("a foreign pipeline registry is preserved and refuses the patch", () => {
	const foreign = new Map();
	const native = () => "native";
	const proto: any = { method: native };
	Object.defineProperty(proto, METHOD_PIPELINE_KEY, { value: foreign, configurable: true });
	assert.throws(() => installMethodStep(proto, "method", () => () => {}), /method-pipelines/);
	assert.equal(proto[METHOD_PIPELINE_KEY], foreign, "the foreign registry is never replaced");
	assert.equal(proto.method, native, "the method is untouched");
	assert.equal(captureMethod(proto, "method"), native, "readers ignore a foreign registry");
});

test("missing host capability fails before any method change", () => {
	const proto: any = {};
	assert.throws(() => installMethodStep(proto, "missing", () => () => {}), /lacks missing/);
	assert.equal(proto.missing, undefined);
});

test("failed step factory rolls back its empty dispatcher and registration", () => {
	const native = () => "native";
	const proto = { method: native };
	assert.throws(() => installMethodStep(proto, "method", () => { throw new Error("fixture failure"); }), /fixture failure/);
	assert.equal(proto.method, native);
	assert.equal(Object.hasOwn(proto, Symbol.for("pi-ui.method-pipelines")), false);
});
