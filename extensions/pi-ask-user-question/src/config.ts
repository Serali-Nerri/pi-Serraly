/**
 * Limits and environment switches for AskUserQuestion.
 *
 * The numeric limits and label constants mirror Claude Code 2.1.259; see README.md for how
 * they were extracted from the binary.
 */

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER = 12;

/** Claude Code's sentinel answer when a question only received notes. */
export const NOTES_ONLY = "(notes only)";
export const OTHER_LABEL = "Other";
export const CHAT_LABEL = "Chat about this";

/**
 * Environment switches for the optional auto-continue ("away from keyboard") timer, which is
 * off by default. Claude Code uses `CLAUDE_AFK_TIMEOUT_MS` / `CLAUDE_AFK_COUNTDOWN_MS`; pi uses
 * its own names to keep both silent when unset.
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
