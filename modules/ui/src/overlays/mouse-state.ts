let hoveredToolCallId: string | null = null;
let activeTui: any;
export function isToolCallHovered(id: string | undefined): boolean { return id != null && hoveredToolCallId === id; }
export function setHoveredToolCallId(id: string | null): void { hoveredToolCallId = id; }
export function getToolMouseTui(): any { return activeTui; }
export function setToolMouseTui(tui: any): void { activeTui = tui; }
