# add-dir

Reference directories outside the current working directory in one Pi session.
The module owns `/dir-add` and `/dir-ls`, the `add-dir` widget, and the
`pi_add_dir` system-prompt section. It registers no model tools and never
reloads Pi by itself.

```text
/dir-add /srv/other-project
/dir-add ~/work/reference
/dir-add --project ../sibling-repo
/dir-add --global /opt/shared-conventions
/dir-ls
```

## Commands

`/dir-add [--project | --global] [path]` adds one directory. Without a scope
flag the directory belongs to the current session. Relative paths resolve
against the session working directory, `~` expands to the home directory, and
symlinks resolve to their canonical target. Without a path, an interactive UI
prompts for one; without any interactive UI the command reports its usage
instead of waiting.

`/dir-ls` lists every managed directory with its scope and stored value, marks
inactive entries with the reason, and — when an interactive UI exists — lets one
be removed from its own scope. Cancelling changes nothing. Every selector row
includes its snapshot ordinal, so even identical escaped names or paths ending
in an ordinal cannot make a selection ambiguous. Removal uses the selected
stored spelling, so filesystem retargeting while the selector is open cannot
change which entry is deleted.

Commands are serialized, and each one is bound to the session and branch it was
admitted in: a command that is still waiting for Git, for a queued sibling or for
a prompt when the session changes discards itself instead of writing into the
branch that replaced it. The live leaf is compared against the session manager
itself, so this holds even in the moment Pi switches branches — which happens
before it announces `session_tree`, and therefore before this module can react.
Whenever that check finds the host on another branch, the cached directories are
re-read from that branch first, so a command never writes one branch's list onto
another. A delayed navigation announcement does not expire a command already
admitted on its target branch. If the host cannot resolve the admitted leaf,
navigation announcements conservatively invalidate pending commands instead.

## Scopes and resolution

| Scope | Stored in | Lifetime |
| --- | --- | --- |
| session | Pi custom entry `add-dir:state` | the active session branch |
| project | Git local config `pi-add-dir.directory` | the repository, shared by linked worktrees |
| global | `<agent-dir>/config/pi-add-dir/config.json` | every session |

Same path wins in `session → project → global` order. A persistent directory
that is missing, cannot be resolved, duplicates a higher scope, or nests with
another active directory or with the working directory is kept in configuration
and reported as inactive; nothing is silently corrected or deleted. Project
scope requires a Git repository.

A directory that has a session copy and no persistent counterpart is promoted
when the same path is added with `--project` or `--global`: the persistent write
happens first, and only then is the session copy removed. `/dir-ls` can remove
the session copy directly if that second step fails.

Restoring a session reads only the deepest `add-dir:state` entry on the active
branch, so abandoned branches never contribute directories, and a restored
session directory stays active even if it no longer exists. A stored root whose
resolution fails, such as a symlink loop or an unreadable location, is retained
as an inactive managed row instead: healthy entries continue to load, and the
bad row remains removable. Unreadable stored references do not block unrelated
additions or promotions; newly requested paths still require successful
resolution and directory validation.

## Context loading

Root and `.pi` `AGENTS.md` and `CLAUDE.md` from every active directory are
injected into one named system-prompt section that is refreshed for each agent
run; other prompt sections are untouched, and the section is removed when no
directory is active. Directory state, the widget and `@` completion change
immediately, while instructions are re-read for the next agent run — no
`/reload` is needed for them. Instruction files are read as strict UTF-8, whole
or not at all: a file over 64 KiB, or instructions pushing the whole section
past 128 KiB, are skipped and reported instead of being truncated.

Skills in `<dir>/.pi/skills`, `<dir>/.agents/skills` and `<dir>/.claude/skills`
are offered to Pi's resource loader as `SKILL.md` paths. Validity, name
collisions and load order remain Pi's decision, so a skill that Pi rejects —
because a higher-priority skill already owns the name, or because its
frontmatter is invalid — is reported by Pi and does not leave this module asking
for a reload forever.

`@` completion keeps every suggestion the host provider already produced and
adds absolute candidates from the active directories. Unquoted `@namespace:`
queries are passed through unchanged when the delegated provider declines file
completion through `shouldTriggerFileCompletion`, so explicit reference namespaces
are never mixed with external files. Ordinary relative file queries still add
external candidates independently of the provider's Tab-trigger preference.
Queries that are already absolute, `~/…`, `./…` or `../…` are passed through
unchanged, including their backslash spellings: scope classification follows
Pi's slash normalization.
A candidate the host builds from a file name inside an external directory is
dropped when its text could move the terminal cursor, and the descriptions
this module adds are escaped like every other string it prints. Ordinary
relative query suffixes, including terminal dot segments, are passed to Pi
without path normalization.

Completion re-reads the host's live branch even before navigation event delivery,
and asynchronous external results are kept only while their directory is still
active in the same UI binding. A probe that the host parses as a different token
is discarded rather than relabelled as an external suggestion.
Even a prefix-matching reply must contain absolute attachments under the
declared base: relative cwd fallbacks and parent-scope paths outside that base
are not external candidates. The host's original local response is not filtered.
On POSIX, literal-backslash directory names are also omitted from external
completion because Pi interprets those backslashes as path separators; they
remain available for context and skills.

The widget shows the active directory count, their labels and whether a reload
is pending. It appears only in the TUI; print, JSON and RPC modes keep full
directory state without terminal components.

## The `/reload` boundary

Directory state, `@` completion and the widget update immediately; instruction
files are re-read for the next agent run. Skills are a host resource, so adding
or removing one changes the module's wish list, not the loaded skill set.

While the two disagree, commands append `Run /reload to update external skills.`
and the widget marks the pending state. Pi's own `/reload` re-runs resource
discovery, after which the module compares what it handed over with what Pi
actually loaded and clears the marker. The module never starts a reload, never
sends a user message, and never edits skill contents on disk — editing a
`SKILL.md` still needs `/reload`. Command results are informational: print,
JSON and SDK sessions without an interactive UI report failures and warnings on
stderr and keep successful results out of the protocol streams.

## Security

This is not a sandbox. Adding a directory puts its instructions and skills into
the session's context and `@` candidates, and symlinks are followed; it does not
grant the model any tool permission it did not already have. Add only
directories whose instructions and skills you are willing to place in the
session's context. Directory paths containing control characters or Unicode line
separators are rejected in every scope, and legacy session entries containing
them are ignored on restore. Every rendered name escapes those characters and the
invisible bidi overrides, while shaped names — joined emoji, combining marks,
private-use glyphs — stay readable.

Installation, building, validation and release staging are root-package
responsibilities. This entry replaces the upstream `pi-add-dir` extension: do
not enable both at once.

See [UPSTREAM.md](./UPSTREAM.md) for provenance and deliberate deviations.
