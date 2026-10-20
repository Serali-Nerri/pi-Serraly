import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

// One namespace keeps the three same-name replacements grouped in codemode listings.
const FILESYSTEM_NAMESPACE = {
	name: "filesystem",
	description: "Search file contents, find paths, and list local directories",
};

/**
 * Registers same-name replacements for the built-in grep, find and ls tools.
 * The replacements reuse the host definitions without their
 * renderers and are reachable from codemode unless a session activates them.
 */
export default function toolsExtension(pi: ExtensionAPI): void {
	for (const definition of [
		createGrepToolDefinition(process.cwd()),
		createFindToolDefinition(process.cwd()),
		createLsToolDefinition(process.cwd()),
	]) {
		const { renderCall: _renderCall, renderResult: _renderResult, renderShell: _renderShell, ...rest } = definition;
		pi.registerTool({ ...rest, exposure: "codemode", namespace: FILESYSTEM_NAMESPACE });
	}
}
