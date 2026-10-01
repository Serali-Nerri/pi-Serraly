import type { IconMode } from "./icons.ts";

export const ICON_MODE: IconMode = "ascii";

export const FOOTER_SEGMENTS = Object.freeze({
	cwd: true,
	sessionName: false,
	gitBranch: true,
	gitStatus: true,
	gitCommit: false,
	runtime: true,
	context: true,
	tokens: true,
	cost: true,
	extensionStatuses: true,
});

export type FooterSegments = typeof FOOTER_SEGMENTS;
