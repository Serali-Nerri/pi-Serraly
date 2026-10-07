/**
 * The Node baseline every root entry point enforces before doing any work.
 *
 * The workspace, its sealed artifacts and the qualified Pi 1.0.4 host are only
 * verified on Node >= 22.19.0. An older runtime fails loudly instead of being
 * retried, downgraded or reported as a skip, and an unparseable version string
 * fails closed rather than being treated as supported.
 */
export const MINIMUM_NODE = "22.19.0";

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** Parse `22.19.0` or `v22.19.0`; returns undefined for anything else. */
export function parseNodeVersion(version) {
	if (typeof version !== "string") return undefined;
	const match = VERSION.exec(version);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Numeric semantic comparison: negative when `a` precedes `b`. */
export function compareNodeVersions(a, b) {
	for (let index = 0; index < 3; index++) {
		if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
	}
	return 0;
}

/** Fail closed when the running (or given) Node is below the qualified baseline. */
export function assertSupportedNode(version = process.versions.node) {
	const parsed = parseNodeVersion(version);
	if (parsed === undefined) throw new Error(`Unsupported Node version string: ${JSON.stringify(version)}; expected ${MINIMUM_NODE} or newer`);
	const minimum = parseNodeVersion(MINIMUM_NODE);
	if (compareNodeVersions(parsed, minimum) < 0) {
		throw new Error(`Node ${version} is below the supported baseline ${MINIMUM_NODE}; upgrade Node before building, testing or releasing`);
	}
}
