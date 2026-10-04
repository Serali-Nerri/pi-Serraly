/**
 * Host capability preflight for the private display patches.
 *
 * Pi 1.0.0 exposes the interactive components as classes whose methods are
 * replaced by reference. Before any patch is installed this module verifies that
 * every required method exists and can be replaced. The probe writes nothing and
 * never invokes an accessor, so a hostile or newer host cannot be mutated by a
 * failed check. It only covers public prototype members: it makes no claim about
 * private instance fields, and the real host plus visual acceptance remain the
 * authority for those.
 *
 * Installers keep their own in-place check through `requireReplaceableMethod`, so
 * a method that stops being replaceable between the probe and the install fails
 * with the same named capability instead of leaving a partial patch.
 */
import {
	AssistantMessageComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, TuiAltScreen } from "@earendil-works/pi-tui";
import { ForeignPatchError, isOwnedPatch, OWNERSHIP_SLOTS, slotName } from "./patch-keys.ts";
import { METHOD_PIPELINE_KEY } from "./method-pipeline.ts";

/** A failed capability check: the named host members are unusable for patching. */
export class HostCapabilityError extends Error {
	readonly capabilities: readonly string[];

	constructor(capabilities: readonly string[]) {
		super(`Pi 1.0.0 host cannot be patched for display: ${capabilities.join(", ")}; native rendering retained`);
		this.name = "HostCapabilityError";
		this.capabilities = [...capabilities];
	}
}

type Requirement = {
	owner: string;
	target: object;
	name: string;
	/** Absent is acceptable, but a present member must still be replaceable. */
	optional?: boolean;
};

/**
 * Every host prototype the compat domains patch. Their pipeline slots must be
 * owned or absent; a foreign map means another patch already manages them.
 */
const PATCHED_PROTOTYPES: readonly { owner: string; prototype: object }[] = [
	{ owner: "ToolExecutionComponent", prototype: ToolExecutionComponent.prototype },
	{ owner: "AssistantMessageComponent", prototype: AssistantMessageComponent.prototype },
	{ owner: "SkillInvocationMessageComponent", prototype: SkillInvocationMessageComponent.prototype },
	{ owner: "CompactionSummaryMessageComponent", prototype: CompactionSummaryMessageComponent.prototype },
	{ owner: "BranchSummaryMessageComponent", prototype: BranchSummaryMessageComponent.prototype },
	{ owner: "Container", prototype: Container.prototype },
	{ owner: "TuiAltScreen", prototype: TuiAltScreen.prototype },
];

function requirement(owner: string, target: object, name: string, optional = false): Requirement {
	return optional ? { owner, target, name, optional } : { owner, target, name };
}

const TOOL = ToolExecutionComponent.prototype;
const ASSISTANT = AssistantMessageComponent.prototype;

/**
 * Every host member the compat domains patch. `handleMouse` is optional: Pi
 * supplies it for the components that have one, and the mouse domain installs its
 * own handler where the prototype allows it.
 */
const REQUIREMENTS: readonly Requirement[] = [
	...["hasRendererDefinition", "getRenderShell", "getCallRenderer", "getResultRenderer", "updateDisplay", "render", "createResultRegion"]
		.map((name) => requirement("ToolExecutionComponent", TOOL, name)),
	...["updateContent", "render"].map((name) => requirement("AssistantMessageComponent", ASSISTANT, name)),
	...["addChild", "removeChild", "clear"].map((name) => requirement("Container", Container.prototype, name)),
	...[[SkillInvocationMessageComponent, "SkillInvocationMessageComponent"],
		[CompactionSummaryMessageComponent, "CompactionSummaryMessageComponent"],
		[BranchSummaryMessageComponent, "BranchSummaryMessageComponent"]]
		.flatMap(([component, owner]) => ["updateDisplay", "render"].map((name) => requirement(owner as string, (component as { prototype: object }).prototype, name))),
	requirement("TuiAltScreen", TuiAltScreen.prototype, "dispatchMouseToLayout"),
	requirement("AssistantMessageComponent", ASSISTANT, "handleMouse", true),
	requirement("SkillInvocationMessageComponent", SkillInvocationMessageComponent.prototype, "handleMouse", true),
	requirement("CompactionSummaryMessageComponent", CompactionSummaryMessageComponent.prototype, "handleMouse", true),
	requirement("BranchSummaryMessageComponent", BranchSummaryMessageComponent.prototype, "handleMouse", true),
];

/** Read a descriptor through the prototype chain without executing an accessor. */
function descriptorOf(target: object, name: string): PropertyDescriptor | undefined {
	for (let current: object | null = target; current !== null; current = Object.getPrototypeOf(current)) {
		const descriptor = Object.getOwnPropertyDescriptor(current, name);
		if (descriptor !== undefined) return descriptor;
	}
	return undefined;
}

/** The reason a requirement is unusable, or undefined when it is satisfied. */
function capabilityFailure({ target, name, optional }: Requirement): string | undefined {
	const descriptor = descriptorOf(target, name);
	const own = Object.getOwnPropertyDescriptor(target, name);
	if (descriptor === undefined) {
		if (optional === true) return Object.isExtensible(target) ? undefined : "target not extensible";
		return "missing";
	}
	if (descriptor.get !== undefined || descriptor.set !== undefined) {
		// An accessor is replaceable only through its setter; never call the getter.
		return descriptor.set === undefined ? "getter-only, not replaceable" : undefined;
	}
	if (typeof descriptor.value !== "function" && !(optional === true && descriptor.value === undefined)) return "not a method";
	if (descriptor.writable !== true) return "not writable";
	if (own === undefined && !Object.isExtensible(target)) return "target not extensible";
	return undefined;
}

function describe(requirement: Requirement, failure: string): string {
	return `${requirement.owner}.${requirement.name} (${failure})`;
}

/** Read-only preflight over every patched host member. */
export function probeHostCapabilities(): { ok: boolean; missing: readonly string[] } {
	const missing = REQUIREMENTS.flatMap((entry) => {
		const failure = capabilityFailure(entry);
		return failure === undefined ? [] : [describe(entry, failure)];
	});
	return { ok: missing.length === 0, missing };
}

/** Throw one error listing every unusable capability. */
export function requireHostCapabilities(): void {
	const { missing } = probeHostCapabilities();
	if (missing.length > 0) throw new HostCapabilityError(missing);
}

/**
 * Refuse a host where a foreign patch already owns one of this module's slots or
 * one of the patched prototypes' pipeline registries. Only descriptors are read:
 * an accessor slot is foreign, and no external getter, disposer or `stop` runs.
 * The check runs before any of our own owners are released, so a conflict cannot
 * leave the UI half-uninstalled.
 */
export function assertUiPatchOwnership(): void {
	const foreign: string[] = [];
	for (const key of OWNERSHIP_SLOTS) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		if (descriptor === undefined) continue;
		if (descriptor.get !== undefined || descriptor.set !== undefined || !isOwnedPatch(descriptor.value)) foreign.push(slotName(key));
	}
	for (const { owner, prototype } of PATCHED_PROTOTYPES) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, METHOD_PIPELINE_KEY);
		if (descriptor === undefined) continue;
		if (descriptor.get !== undefined || descriptor.set !== undefined || !isOwnedPatch(descriptor.value)) {
			foreign.push(`${owner}.${slotName(METHOD_PIPELINE_KEY)}`);
		}
	}
	if (foreign.length > 0) throw new ForeignPatchError(foreign[0]!, foreign.slice(1));
}

/**
 * In-place guard for one patch site: the member must exist (unless optional) and
 * the target must allow the assignment the installer is about to perform.
 */
export function requireReplaceableMethod(
	owner: string,
	target: object,
	name: string,
	{ optional = false }: { optional?: boolean } = {},
): void {
	const entry = requirement(owner, target, name, optional);
	const failure = capabilityFailure(entry);
	if (failure !== undefined) throw new HostCapabilityError([describe(entry, failure)]);
}
