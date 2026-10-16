# add-dir upstream and migration

## Imported baseline

- Read-only source: `HenryQW/pi-harness` at commit
  `4d9ed14b8016abcecb3d97af8c28ca37a3ca265f`.
- `extensions/pi-add-dir/` version 2.1.6 (entry `extensions/add-dir.ts` plus
  `add-dir-helpers.ts` and `add-dir-config.ts`).
- `packages/pi-config-store/` version 2.0.2, imported as the pinned dependency
  `@henryqw/pi-config-store: "2.0.2"` under `extensions/pi-add-dir/package.json`.
- Upstream `LICENSE` (MIT, itisbryan / shelken / Henry Wang) is retained
  byte-for-byte as [LICENSE](./LICENSE).

## Deliberate deviations

1. **No model tools.** `add_directory` and `search_external_files` — together
   with their schemas, renderers, `findFiles` traversal, glob normalization and
   the `Text`/`typebox` imports only they used — are removed. Directory
   management is an explicit user action.
2. **No `/dir-reload`.** The alias, its `ctx.reload()` call and the
   `session_tree` `pi.sendUserMessage("/dir-reload")` dispatch are removed. Pi's
   own `/reload` is the only reload boundary, and this module never triggers one.
3. **Reload detection rebuilt.** Upstream compared the discovered skill set
   before and after each edit, which loses the pending hint after an unrelated
   edit and misreports branches and removals. `src/resources.ts` instead records
   the paths this binding handed to `resources_discover` and compares them with
   the skills `pi.getCommands()` reports as loaded; candidates the host rejected
   (name collision, invalid frontmatter) are suppressed instead of demanding a
   reload that can never settle.
4. **Bounded instruction reads.** `readFileSafe` is replaced by the config
   store's strict-UTF-8 bounded reader. Instructions are read whole or skipped
   whole, with a 64 KiB per-file and 128 KiB per-section budget; only regular
   files are read, and one unreadable file or skill candidate never aborts the
   rest of the section or the other candidates.
5. **Promotion order and commit points.** Persistent writes commit first and the
   session copy is removed afterwards, so a failed write needs no compensating
   append and a partially applied append can be reconciled against the session
   Pi actually recorded. A re-read that fails after a committed write is a
   warning, not a rollback.
6. **Per-session re-arm.** Pi reuses extension instances when a session is
   replaced (new/resume/fork) while it has already reset its own UI, so each
   `session_start` re-arms the abort lifetime, the shutdown latch, the
   completion registration and the diagnostic dedupe, and every asynchronous
   write checks the session generation before publishing.
7. **Repo-shaped layout.** The single upstream closure is split into
   `src/index.ts`, `directories.ts`, `storage.ts`, `resources.ts`,
   `autocomplete.ts` and `presentation.ts` with the workspace's strict
   NodeNext/no-emit TypeScript boundary, and a `test/` suite that drives the
   real factory through the public host boundary.
8. **Terminal UI guard.** The widget and `@` completion require TUI mode, not
   merely `hasUI`, because RPC reports `hasUI` while discarding widget
   factories; `/dir-ls` prints its list instead of opening a selector when no
   interactive UI exists.
9. **Git marker check.** A `.git` entry counts as a repository marker only when
   it is a git directory containing `HEAD` or a `gitdir:` file, so stray
   directories named `.git` cannot turn "not a repository" into a corruption
   error.
10. **Control characters and completion parity.** Directory paths containing
    terminal controls or line separators are rejected uniformly (including
    session scope) and restored entries are filtered. `@` token boundaries
    mirror Pi 1.3.0's prose separators. Relative query suffixes remain raw, so
    empty and terminal-dot queries preserve the external search scope instead
    of normalizing into a parent-directory search. Explicit scopes use Pi's
    slash normalization, and external attribution requires absolute attachments
    under the declared base rather than accepting Pi's relative cwd fallback.
11. **Stored-reference isolation.** Root resolution errors retain the affected
    entry as an inactive managed row without losing healthy session resources
    or blocking unrelated additions and promotions. Removing a selected
    session entry uses its captured stored spelling, not a filesystem target
    that may have changed while selection was pending.

Retained upstream behavior: `/dir-add [--project | --global] [path]`,
`/dir-ls`, session/project/global scopes, Git-local persistence shared across
worktrees, scope precedence, inactive-reporting instead of auto-correcting,
session branch restore, persistent-first session-to-persistent promotion, the
`add-dir:state` / `pi-add-dir.directory` / `config/pi-add-dir/config.json`
names, `.pi|.agents|.claude/skills` discovery, root and `.pi`
`AGENTS.md`/`CLAUDE.md` injection, the `pi_add_dir` prompt section, `@`
completion wrapping and the directory widget.

## Bundled third-party licenses

`package.json` declares the license files the sealed artifact must carry in
`serraly.bundledLicenses`; `scripts/lib/build-package.mjs` copies them from the
locked dependency tree at build time:

- `licenses/pi-config-store-MIT.txt` — `@henryqw/pi-config-store` 2.0.2
- `licenses/proper-lockfile-MIT.txt` — `proper-lockfile` 4.1.2
- `licenses/graceful-fs-ISC.txt` — `graceful-fs` 4.2.11
- `licenses/retry-MIT.txt` — `retry` 0.12.0 (proper-lockfile's nested copy)
- `licenses/signal-exit-ISC.txt` — `signal-exit` 3.0.7

The config store and its transitive dependencies are bundled into
`dist/pi-add-dir.js`; the module declares no runtime dependencies of its
own.

## Not migrated

`/dir-reload`, `add_directory`, `search_external_files` and any codegraph MCP
integration. Automatic loading of external extensions, prompts or themes,
working-directory switching, tool-permission changes and deployment into a live
Pi installation are out of scope for this module.
