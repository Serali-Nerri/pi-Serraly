import { registerScriptedProvider } from "./scripted-provider.js";

export default function (pi) {
	// The worker inspects the same state after a synthetic turn.
	const state = (globalThis[Symbol.for("serraly.sdk-fixture")] ??= {});
	registerScriptedProvider(pi, state);
	// Sampled after the host merged extension resources, so this is the real skill inventory
	// the module's reload reconciliation consumes.
	pi.on("before_agent_start", () => {
		state.skillCommands = pi
			.getCommands()
			.filter((command) => command.source === "skill")
			.map((command) => ({ name: command.name, path: command.sourceInfo?.path }))
			.sort((left, right) => left.name.localeCompare(right.name));
	});
}
