const JS_CELL_DESCRIPTION =
	"JavaScript computation/tool calls; source ONLY, NO JSON/fences";
const MCP_OUTPUT_GUIDANCE =
	"MCP results may be envelopes: pass only verified blocks or block arrays (often result.content) to content(...); serialize other values with text(...)";

export const EXEC_DESCRIPTION = `${JS_CELL_DESCRIPTION}
Optional // @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}; defaults=30000ms/10000tokens
Bare values discarded; globals: tools, image, generatedImage, store, load, exit, setTimeout, clearTimeout, ALL_TOOLS; content(value)→emit MCP text/images in order; text(value)→print serialized output; notify(value)→emit; both→undefined
${MCP_OUTPUT_GUIDANCE}`;

export const ISOLATED_EXEC_GUIDANCE =
	'Concurrent isolated: // @exec: {"isolated":true}; last checkpoint; shared vars unchanged';

export const VM_EXEC_DESCRIPTION = `${JS_CELL_DESCRIPTION}
Optional // @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}; defaults=30000ms/10000tokens
Bare values discarded; globals: tools, text, image, notify, generatedImage, store, load, exit, console, ALL_TOOLS
content(value)→emit MCP text/images in order
${MCP_OUTPUT_GUIDANCE}`;

export const WAIT_DESCRIPTION = "Resume or terminate a yielded exec cell";
