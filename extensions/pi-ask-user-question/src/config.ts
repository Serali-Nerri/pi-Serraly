/**
 * Limits and environment switches for AskUserQuestion.
 */

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER = 12;

/** Sentinel answer when a question only received notes. */
export const NOTES_ONLY = "(notes only)";
export const OTHER_LABEL = "Other";
export const CHAT_LABEL = "Chat about this";

/**
 * Environment switches for the optional auto-continue ("away from keyboard") timer, which is
 * off by default and silent when unset.
 */
export const AFK_ENV = "PI_ASK_USER_QUESTION_AFK_MS";
export const AFK_COUNTDOWN_ENV = "PI_ASK_USER_QUESTION_AFK_COUNTDOWN_MS";
export const AFK_DEFAULT_COUNTDOWN_MS = 30_000;

export function envInt(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}
