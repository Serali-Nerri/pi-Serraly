import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApplyPatchTool } from "./tool.ts";

/** Registers one additional tool. It never changes the active tool set. */
export default function applyPatchExtension(pi: ExtensionAPI): void {
	pi.registerTool(createApplyPatchTool());
}
