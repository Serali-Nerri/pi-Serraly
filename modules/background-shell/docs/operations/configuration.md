---
{
  "doc_id": "operations/configuration",
  "covers_sources": [
    "src/core/config.ts",
    "src/core/shell-policy.ts"
  ],
  "covers_surfaces": []
}
---
# Configuration and shell selection

Configuration is resolved at activation. `/reload` rereads it for new tasks; surviving executions retain their original launch facts. Invalid settings fail, not silently fall back.

## POSIX

| Variable | Meaning |
| --- | --- |
| `PI_BG_POSIX_SHELL` | Exactly `inherit` (default), `bash`, or `sh`. |
| `PI_BG_POSIX_SHELL_PATH` | Optional absolute executable file, only with explicit `bash`/`sh`. Invalid paths fail without search fallback. |
| `SHELL` | In `inherit` mode use the nonempty value, otherwise `/bin/sh`. |

Explicit `bash`/`sh` checks `/bin/bash` or `/bin/sh` first, then PATH in order. Relative PATH entries are resolved at activation. The executable is passed as structured spawn input, never interpolated into command text. Bash/sh use `-c`, not `-lc`: no login-shell flag is requested (shell-specific startup behavior still applies).

Inherited `bash` is reported as Bash; reviewed Bourne-family names are POSIX-compatible. Fish, Nu, csh/tcsh and unknown names are not mislabeled as POSIX/Bash. Inheritance intentionally does not replace or prevalidate the user's executable; spawn errors remain visible.

## Windows

Default is `ComSpec`/`cmd.exe`, ignoring generic `SHELL` and both POSIX variables. Cmd invocation uses `/d /s /c "<command>"` with structured argv and Windows verbatim arguments.

`PI_BG_SHELL=cmd|bash` selects syntax. Optional `PI_BG_SHELL_PATH` requires that selection and an absolute `.exe`/`.com` file. Without a Bash path, search PATH for `bash.exe`/`bash.com`; failure is loud. Bash uses `-c`, not `-lc`.

## Description-only shell contract

`bg_run.description` is exactly static exported `BG_RUN_DESCRIPTION` plus `shellPolicyDescription(shellPolicy)`. The suffix reports the selected executable, argument list, command syntax and whether a login flag is requested; it does not expose the environment. The same immutable policy drives actual spawn.

No tools have `promptSnippet`/`promptGuidelines`, and no `before_agent_start` or alternative system-prompt injection is used. Generated docs record the static base and suffix **rule**, not a maintainer's shell path. The gate uses AST data extraction, never evaluates extension code.

## Other settings

| Setting | Contract |
| --- | --- |
| `PI_BG_DOCK_SHORTCUT` | Exactly `shift+down` (default), `ctrl+alt+b`, or `off`. Off disables only the dock key, not commands. |
| `PI_BG_MAX_OUTPUT_BYTES` | Positive safe integer, default 20 MiB. Invalid values fail; overflow fails and kills the task. |
| `timeoutSeconds` | Tool launch accepts finite values >=1, rounded down to whole seconds; omitted means no timeout. EventBus requires a positive integer. |
| `surviveReload` | Per-launch opt-in, default false; `/bg --survive-reload`. Not an EventBus field. |

The feature selector, usage telemetry settings, and update checker were removed; this fork makes no update requests. See [runtime](../subsystems/background-task-runtime.md) and [dock](../reference/shortcuts-and-dock.md).
