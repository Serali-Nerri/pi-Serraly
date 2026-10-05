# questions

Interactive `AskUserQuestion` clarification for Pi 1.0.2. This module owns its
question dialog and transcript renderers independently of the UI module; the tool
card uses the shared `pi-ui-kit` header/status syntax, while answers, notes,
attached previews, cancellation and AFK handling stay local.

## Tool contract

- Name: `AskUserQuestion`; namespace: `questions`.
- Exposure: `deferred`; execution: `sequential`. The host’s `tool_search` can
  discover and activate it; this module does not change the active-tool set.
- Parameters: 1–4 `questions`; each has a unique `question` text, `header` of at
  most 12 characters, and 2–4 `options` with unique labels, required descriptions,
  and optional Markdown `preview`. `multiSelect` is optional and defaults to false.
- Validation rejects duplicate question texts, duplicate option labels, and
  questions with no real choice before opening the dialog.
- Only `ctx.mode === "tui"` opens the dialog. RPC/print/JSON return the original
  requires-interactive-TUI text with `details: { questions, answers: {} }`, not a
  fabricated answer. This is a text result, not a thrown tool error.

## Interaction

| Input | Action |
| --- | --- |
| ↑ / ↓ | Move the option cursor |
| Enter | Confirm a choice, advance, or submit editor text |
| Space | Toggle a multi-select choice |
| Tab / Shift+Tab / ← / → | Switch questions and the review page |
| `n` | Add notes to the current question |
| Esc | Leave an input editor; from options, cancel the dialog |
| Other | Enter a custom answer |
| Chat about this | Enter a freeform `response` |

Multiple questions require review and block submission until all are answered.
Single-select previews appear beside options at 96 columns or wider, otherwise
below them. HTML previews degrade to readable text; multi-select previews are
not displayed. Text editors use the host’s focus and key handling.

## Results

Model-facing text and `details` preserve the original answer mapping:

```ts
{
	questions: QuestionInput[],
	answers: Record<string, string>, // question text → answer
	annotations?: Record<string, { preview?: string; notes?: string }>,
	response?: string,
	afkTimeoutMs?: number,
	cancelled?: boolean,
}
```

Multi-select labels are joined with `", "`; labels containing `", "` or quotes
are JSON-quoted. Custom text takes precedence over selected labels. Notes-only
answers use the sentinel `(notes only)`. Selected single-choice previews are
returned as annotations.

- Clean option answers: `Your questions have been answered: …`.
- Custom answers or notes: `The user answered: …`, with the original caution to
  follow what the user actually says.
- Chat response: `The user responded: …`.
- AFK: `No response after Ns — the user may be away from keyboard. …`.
- Cancellation: `The user did not answer the questions.`, empty answers and
  `cancelled: true`.

## AFK configuration

| Environment variable | Meaning |
| --- | --- |
| `PI_ASK_USER_QUESTION_AFK_MS` | Positive millisecond timeout; unset disables auto-continue |
| `PI_ASK_USER_QUESTION_AFK_COUNTDOWN_MS` | Countdown display window; default `30000` ms |

The timer ticks each second. Any key resets the idle countdown; completion and
component disposal clear the timer. Partial selections/notes are preserved in
an AFK outcome.

Build, installation,
validation safety, and release instructions belong to the root package.
