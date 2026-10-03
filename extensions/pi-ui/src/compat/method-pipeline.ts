// One host wrapper per method. Ordered display steps can join/leave independently.
const KEY = Symbol.for("pi-ui.method-pipelines");
type Method = (this: any, ...args: any[]) => any;
type Step = { active: boolean; invoke: Method };
type Pipeline = { native: Method; dispatch: Method; steps: Step[] };

function pipelines(proto: any): Map<string, Pipeline> {
	if (!Object.hasOwn(proto, KEY)) Object.defineProperty(proto, KEY, { value: new Map(), configurable: true });
	return proto[KEY];
}
function snapshot(pipeline: Pipeline): Method {
	const last = pipeline.steps.at(-1);
	return last?.invoke ?? pipeline.native;
}

/** Capture lower display steps, never the mutable dispatcher (which would recurse). */
export function captureMethod(proto: any, name: string): Method {
	const pipeline: Pipeline | undefined = Object.hasOwn(proto, KEY) ? proto[KEY].get(name) : undefined;
	return pipeline && proto[name] === pipeline.dispatch ? snapshot(pipeline) : proto[name];
}

export function nativeMethod(proto: any, name: string): Method {
	return (Object.hasOwn(proto, KEY) ? proto[KEY].get(name)?.native : undefined) ?? proto[name];
}

export function installMethodStep(proto: any, name: string, create: (next: Method) => Method): { dispatch: Method; dispose(): void } {
	if (typeof proto?.[name] !== "function") throw new Error(`Pi display component lacks ${name}`);
	const registry = pipelines(proto);
	let pipeline = registry.get(name);
	const previous = pipeline;
	let mounted = false;
	if (!pipeline || proto[name] !== pipeline.dispatch) {
		const native = proto[name];
		pipeline = { native, dispatch: undefined as any, steps: [] };
		const current = pipeline;
		current.dispatch = function (this: any, ...args: any[]) { return snapshot(current).apply(this, args); };
		try { proto[name] = current.dispatch; } catch (error) {
			if (registry.size === 0 && proto[KEY] === registry) delete proto[KEY];
			throw error;
		}
		registry.set(name, current);
		mounted = true;
	}
	const current = pipeline;
	const next = snapshot(current);
	let handler: Method;
	try { handler = create(next); } catch (error) {
		if (mounted) {
			if (proto[name] === current.dispatch) proto[name] = current.native;
			if (previous) registry.set(name, previous); else registry.delete(name);
			if (registry.size === 0 && proto[KEY] === registry) delete proto[KEY];
		}
		throw error;
	}
	const step: Step = {
		active: true,
		invoke: function (this: any, ...args: any[]) {
			return (step.active ? handler : next).apply(this, args);
		},
	};
	current.steps.push(step);
	return {
		dispatch: current.dispatch,
		dispose() {
			if (!step.active) return;
			step.active = false;
			const index = current.steps.indexOf(step);
			if (index >= 0) current.steps.splice(index, 1);
			if (current.steps.length > 0) return;
			if (proto[name] === current.dispatch) proto[name] = current.native;
			if (registry.get(name) === current) registry.delete(name);
			if (registry.size === 0 && proto[KEY] === registry) delete proto[KEY];
		},
	};
}
