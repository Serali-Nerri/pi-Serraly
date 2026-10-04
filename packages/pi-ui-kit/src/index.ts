/**
 * Shared tool-card syntax for the private pi-Serraly workspace.
 *
 * The library owns the card chrome only: one header line (`● title summary`) and
 * one indented status line (`  ⎿ message`), both coloured through semantic theme
 * roles and bounded to the given width. Body rendering, diff and I/O previews,
 * hover/hitbox behaviour, animation, per-tool information and every renderer
 * registration stay with the owning extension.
 */
export { RenderLines } from "./render-lines.js";
export { padToWidth } from "./text.js";
export {
	renderToolHeader,
	renderToolStatus,
	toolHeaderText,
	toolStatusText,
	type ToolCardColor,
	type ToolCardHeader,
	type ToolCardState,
	type ToolCardStatus,
	type ToolCardTheme,
} from "./tool-card.js";
