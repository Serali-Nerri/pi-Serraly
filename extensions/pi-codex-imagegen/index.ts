import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveImagegenProvider } from "./src/openai.js";
import { registerImagegenInCodeMode } from "./src/pcc.js";
import { createImageGenerationTool } from "./src/tool.js";

export { imagegenCodeModeResult } from "./src/code-mode.js";
export { executeCodexImageGeneration } from "./src/execute.js";
export type { ImagegenOutput } from "./src/output.js";
export { createImageGenerationTool } from "./src/tool.js";

export default function imagegenExtension(pi: ExtensionAPI): void {
	const tool = createImageGenerationTool({
		allowCodexProviderFallback: true,
		resolveProvider: (ctx) => resolveImagegenProvider(pi, ctx),
		promptSnippet: false,
	});
	pi.registerTool(tool);
	registerImagegenInCodeMode(pi, tool);
}
