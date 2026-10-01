import assert from "node:assert/strict";
import test from "node:test";
import { captureMethod, installMethodStep } from "../src/compat/method-pipeline.ts";

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
