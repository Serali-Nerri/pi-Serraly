# ask-user-question

One model tool for Pi 1.1.0: `ask_user_question` opens a structured
questionnaire so a blocking decision comes back as typed answers instead of a
guess. The module owns the tabbed dialog, the native RPC dialog fallback and
the optional config file. It registers no commands, no renderers and no prompt
sections.

The tool is registered `exposure: "model-only"` with `executionMode:
"sequential"`: the model sees and calls it directly, while codemode scripts and
nested tool calls cannot open a second questionnaire on top of one already
waiting.

## Parameters

```ts
ask_user_question({
  questions: [{
    question: string,          // the complete question
    header: string,            // chip label, max 16 characters
    options: [{                // 2-4 entries
      label: string,           // max 60 characters
      description: string,     // what the choice means or costs
      preview?: string,        // markdown shown beside the options; single-select only
    }],
    multiSelect?: boolean,
  }],
})
```

One call carries 1-4 questions. `question`, `header`, each `label` and each
`description` are required. `"Other"`, `"Type something."` and `"Next"` are
reserved labels: authoring one is rejected before the dialog opens.

## The dialog

- Every question gets an appended `Type something.` row for a free-text answer;
  multi-select questions additionally get `Next`.
- `↑`/`↓` move, `Enter` picks, `Space` toggles a checkbox, `Tab`/`Shift+Tab`
  (or `←`/`→`) switch questions, `Esc` abandons the whole questionnaire.
- `n` edits a note for the focused question, or the questionnaire-wide note on
  the Submit tab. Notes reach the model as `user notes:` / `global note:` text
  and do not mark a question answered.
- A single-select option may carry a markdown `preview`; it renders beside the
  option list at 100+ columns and stacks underneath on narrower terminals.
- `Ctrl+G` opens Pi's configured external editor for the focused text draft.
- The default collapse key is `Ctrl+]`; it hides the overlay so the transcript
  becomes readable and restores it on the next press.
- When the questionnaire starts waiting in an interactive terminal, one BEL is
  written to stdout. Redirected and non-TTY output is untouched.

The dialog state lives only in memory: an unfinished questionnaire is not
persisted and is not restored after reload, session replacement or shutdown.

## Results

`content` carries model-facing prose; `details` carries the structured result:

```ts
{
  answers: [{
    questionIndex: number,
    question: string,
    kind: "option" | "custom" | "multi",
    answer: string | null,     // option label, typed text, or null for multi
    selected?: string[],       // multi-select labels
    notes?: string,
    preview?: string,          // echoed when the chosen option carried one
  }],
  cancelled: boolean,
  globalNote?: string,
  error?: "no_ui" | "no_custom_ui" | "no_questions" | "empty_options"
        | "too_many_questions" | "duplicate_question"
        | "duplicate_option_label" | "reserved_label",
}
```

Cancelling and any submission with no answers and no global note collapse to
`User declined to answer questions`. Partial submission is allowed. Validation
errors and host failures carry their own `error` code and never claim the user
declined.

## Host modes

| Mode | Behavior |
| --- | --- |
| Interactive TUI | The full tabbed overlay |
| RPC / ACP | One native `select`/`input` dialog per question; no tabs, notes or side-by-side previews, multi-select is typed indices, and dismissing any dialog cancels the questionnaire |
| No UI | `before_agent_start` strips the tool from the active set, and `execute` still returns `no_ui` if a call arrives |

The reconciler only ever strips the tool; it never re-adds one the operator
removed through tool settings. An aborted tool call cancels an open
questionnaire, kills a still-running external editor and releases the raw
terminal listener.

## Configuration

Optional file, read with a 64 KiB bound; the module never writes it:

```text
<agent-dir>/ask-user-question.json
```

`<agent-dir>` is `PI_CODING_AGENT_DIR`, defaulting to `~/.pi/agent`.

```json
{
  "collapseKey": "alt+o",
  "guidance": {
    "description": "Ask the user whenever requirements are ambiguous."
  }
}
```

| Field | Default | Effect |
| --- | --- | --- |
| `collapseKey` | `"ctrl+]"` | Collapse/expand key spec in Pi's keybinding format, or `"off"` to disable the shortcut. Re-read on every TUI invocation; an already-open questionnaire keeps its resolved key. |
| `guidance.description` | Built-in description | Complete replacement for the model-facing tool description. Read at registration, so it applies after `/reload` or a restart. |

A missing file, malformed JSON or a wrong field type falls back to the default
for that field without failing the tool; a wrong `collapseKey` type is ignored
rather than throwing.

## Limits

No model requests of its own, no network access and no runtime dependencies:
the dialog uses only the Pi host, `pi-tui`, TypeBox and the bundled
`pi-config-core` reader. Installation, building and release staging are
root-package responsibilities.
