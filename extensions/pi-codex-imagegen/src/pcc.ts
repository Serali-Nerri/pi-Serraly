// Optional PCC v1 event protocol. Provenance and update boundary: ../UPSTREAM.md.
import type { AgentToolResult, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { imagegenCodeModeResult } from "./code-mode.js";
import type { createImageGenerationTool } from "./tool.js";

type ImageTool = ReturnType<typeof createImageGenerationTool>;

export interface CodeModeImageTool {
	name: string;
	topLevelName: string;
	toolName: { namespace: string; name: string };
	usage: string;
	description: string;
	deferLoading: boolean;
	kind: "function";
	executionPipeline: "pi";
	inputSchema: unknown;
	renderCall?: ImageTool["renderCall"];
	renderResult?: ImageTool["renderResult"];
	invoke(input: unknown, context: {
		executeTool?: ExtensionToolContext["executeTool"];
		onUpdate?: (result: AgentToolResult<unknown>) => void;
		captureResult?: (result: AgentToolResult<unknown>) => void;
	}, signal: AbortSignal): Promise<unknown>;
}

const channel = "@howaboua/pi-codex-conversion.extension-code-mode-tools/v1";
const refreshChannel = "@howaboua/pi-codex-conversion.extension-code-mode-tools-refresh/v1";

export function registerImagegenInCodeMode(pi: ExtensionAPI, tool: ImageTool): void {
	const adapted: CodeModeImageTool = {
		name: "image_gen__imagegen", topLevelName: tool.name,
		toolName: { namespace: "image_gen", name: "imagegen" },
		usage: "generatedImage(await tools.image_gen__imagegen({prompt:string,transparent_background?:boolean,referenced_image_paths?:string[],num_last_images_to_include?:number})) // prompt: include target aspect ratio and quality; transparency for cutouts, preserve existing transparency in edits; no selectors=generate; paths/recent count=edit; never text/serialize base64 result",
		description: tool.description, deferLoading: false, kind: "function",
		executionPipeline: "pi", inputSchema: tool.parameters,
		renderCall: tool.renderCall, renderResult: tool.renderResult,
		async invoke(input, context, signal) {
			if (signal.aborted) throw new Error("imagegen aborted");
			if (!context.executeTool) throw new Error("Pi nested tool executor is unavailable");
			const { result, isError } = await context.executeTool(tool.name, input, {
				signal, ...(context.onUpdate ? { onUpdate: context.onUpdate } : {}),
			});
			context.captureResult?.(result);
			if (isError) throw new Error(result.content.filter((item) => item.type === "text")
				.map((item) => item.text).join("\n") || "imagegen failed");
			return imagegenCodeModeResult(result);
		},
	};
	const stop = pi.events.on(channel, (request) => {
		if (!request || typeof request !== "object" || !("add" in request) || typeof request.add !== "function") return;
		request.add(() => [adapted], true);
	});
	try { pi.events.emit(refreshChannel, undefined); }
	catch (error) { stop(); throw error; }
	pi.on("session_shutdown", () => {
		stop();
		pi.events.emit(refreshChannel, undefined);
	});
}
