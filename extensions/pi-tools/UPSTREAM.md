# pi-tools source and migration record

## Baseline

- Read-only migration source: `/home/thelya/Work/Scripts/tools` (`pi-apply-patch`).
- Source HEAD: `2b2d877c04796cf70401f22cab48d5a7eeca6b5a`.
- The **current working tree**, not only HEAD, was imported. Modified tracked files were `README.md`, `package.json`, `package-lock.json`, `src/tool.ts`, `test/deploy.test.ts`, and `test/extension.test.ts`. The untracked `.pi/` was excluded without reading its contents.
- Safe pre-migration archive, diff and full SHA-256 manifest: `/tmp/pi-serraly-stage-two-sources-20261002-000556/{tools.tar.gz,tools.patch,manifest.json}`. The module-local [UPSTREAM.SOURCE.json](./UPSTREAM.SOURCE.json) preserves this source's complete file-hash record and archive/diff hashes. Every one of the 106 recorded source files matched that manifest during migration; no source files were changed.
- New maintenance boundary: `extensions/pi-tools/`; the old repository remains historical/read-only.

## Original Codex attribution

The parser, matcher, text updater, Lark grammar and regression fixtures originate from [openai/codex](https://github.com/openai/codex/tree/a6fdb11eda992b706c5e6a21ae5fd8c7376f8e06/codex-rs/apply-patch), pinned at `a6fdb11eda992b706c5e6a21ae5fd8c7376f8e06`.

Original files:

- `codex-rs/apply-patch/src/{parser,streaming_parser,file_update,seek_sequence,text_file}.rs`
- `codex-rs/core/assets/tools/apply_patch.lark`
- `codex-rs/apply-patch/tests/fixtures/scenarios/`

Copyright 2025 OpenAI. Apache-2.0 [LICENSE](./LICENSE) and [NOTICE](./NOTICE) were copied byte-for-byte. This is an independent TypeScript port, not an official OpenAI Pi extension. Original per-file attribution is retained.

## Diff dependency and license

`src/diff.ts` imports the complete `structuredPatch` algorithm from **jsdiff / `diff@8.0.4`**, https://github.com/kpdecker/jsdiff, copyright (c) 2009-2015 Kevin Decker. It is not replaced by a simplified diff implementation or sourced from a private Pi dependency directory. The adapter performs one edit-distance/time-bounded search and projects its hunks to Pi's display-row format.

The package's original BSD-3-Clause license is retained in [licenses/diff-BSD-3-Clause.txt](./licenses/diff-BSD-3-Clause.txt), copied from the exact npm 8.0.4 archive. The copied NOTICE's reference to `node_modules/diff/LICENSE` describes the old deployment layout; the workspace's bundled output must carry this standalone license instead.

## Imported source and tests

- All seven production modules: `index.ts`, `tool.ts`, `grammar.ts`, `patch.ts`, `files.ts`, `report.ts`, `diff.ts`.
- Full parser/text-update, filesystem/locking/commit, bounded-diff and report suites, plus every non-deployment extension behavior test.
- All 25 Codex scenario directories, their original README and `.gitattributes`, and the shared `apply-patch-v1.json` fixture. Fixture bytes were not reformatted or edited.
- Added a real Pi loader migration regression, and an offline SDK regression verifying default direct activation, callable exposure, unchanged built-in tools, and actual system-prompt snippet/guidelines. No requests are sent to a model.

## Intentional workspace deviations

1. Only leading indentation and single-quoted TypeScript literals were normalized to tabs/double quotes. All seven production ASTs and literal values were checked against the source; template-string data, including the Lark grammar and description, remains unchanged. No patch algorithm, file lock, preflight, abort/partial-commit diagnostic, size budget, report contract, tool schema, exposure, namespace or prompt metadata changed.
2. The private module manifest has exact `diff: "8.0.4"` and optional host-provided peers `@earendil-works/pi-coding-agent: "*"` and `typebox: "*"`. No module-local development host copies or lockfile were imported. Root development tooling supplies Pi 1.0.2, TypeBox 1.3.27, TypeScript and tsx.
3. The strict NodeNext/no-emit/erasable-syntax TypeScript boundary covers `src/` and `test/`. Legacy JavaScript deployment checking was removed because the deployment implementation itself was intentionally excluded.
4. The old loader/execution extension test now loads the explicit workspace entry with a temporary agent directory rather than invoking `deploy()`. Its real add/update/no-op byte/identity assertions are retained.
5. The README source-text schema/snippet comparison test was excluded: reading Markdown fragments is not behavior verification. The real registered-tool schema/grammar tests are retained, and the new SDK test checks that prompt metadata actually reaches the initial prompt.
6. README now describes only behavior, inputs, results and contracts. Source/attribution and migration differences moved here; install/build/release policy belongs to the root package.

### Deliberately excluded files/workflows

- `node_modules/`, `.pi/`, `dist/`, `.git/`, old lockfiles and temporary output: dependency, runtime-state or generated artifacts, not source migration inputs.
- `scripts/deploy.mjs` and all of `test/deploy.test.ts`: the old per-extension copy/deploy/backup workflow is **not retained or run**. Its runtime-dependency, license-closure, loader, staged-discovery, prior-version backup, activation-failure recovery, lock, foreign-target/symlink protection and CLI-directory override checks belong to root packaging/migration integration. Real filesystem and partial-commit patch tests were not removed.
- Old `.gitignore` and `AGENTS.md`: repository-local ignore rules and instructions referred to the retired deployment workflow and old formatting/development setup; root workspace guidance replaces them. Their hashes and original source remain in the source record/backup.
- The old `package.json`, `tsconfig.json` and README were adapted rather than copied as standalone release/install documentation. The source's modified deployment test and lockfile are recorded in the baseline even though intentionally not active here.

## Existing port differences from Codex (unchanged)

- Buffered/non-streaming TypeScript implementation; unsupported remote `Environment ID` is explicitly rejected. No Codex CLI, Rust runtime, sandbox, approval system or Ratatui implementation is included.
- Path validation, duplicate-move diagnostics, BOM-aware matching, source-ordered non-overlapping replacements and resource/file-type limits.
- Whole-patch preflight before any writes. Fixture `015_failure_after_partial_success_leaves_changes` intentionally expects no mutation for a later validation error, unlike the standalone Codex CLI. Actual commit I/O failures/cancellation remain non-transactional and explicitly report completed operations without rollback.
- Byte-preserving no-op updates and final/net-change reporting. Successful commits capture immutable snapshots inside the ordered canonical file locks; presentation never re-reads disk.
- Optional bounded `apply_patch.v1` reports. Diff errors, cancellation after commit and calculation/display budgets degrade presentation without turning a successful commit into a tool failure.

## Validation and root handoff

Migration validation used temporary HOME/agent/cwd directories, an allowlisted environment, the root's existing TypeScript/tsx, Pi 0.99.2 and a temporary extraction of the exact `diff@8.0.4` npm archive. No real auth/settings/session/project `.pi` data is read, and no deploy script or provider request is run.

Recorded migration checks:

- **RED:** before production import, `test/migration.test.ts` failed its real-loader assertion with expected `["apply_patch"]`, actual `[]` (exit 1).
- **GREEN:** the same regression passed after import (exit 0). The final strict TypeScript check passed, and the complete module suite passed **173/173**, no failures/cancellations/skips.
- The SDK prompt test also failed against a temporary mutation removing snippet/guidelines, proving it catches loss of model-facing metadata; the unmodified production copy passed.
- The existing root `npm test` passed **801/801** (the then UI-only runner; not yet the integrated stage-two runner). The first launcher attempt failed before tests because npm rejected the same `/dev/null` config path for both user/global configuration; retrying with distinct empty temporary config files passed.
- Logs remain under `/tmp/pi-serraly-apply-patch-validation-m5VYft/`: `red.log`, `green.log`, `prompt-mutation-red.log`, `types.log`, `test.log`, `root-test.log`. Production AST/literal equivalence and byte-identical fixtures/LICENSE/NOTICE were verified independently; all source baseline hashes still match.

## Workspace addition: same-name search tools

`src/index.ts` also registers `grep`, `find` and `ls` as `exposure: "codemode"` replacements for the built-in tools. They import the host's public `createGrepToolDefinition`/`createFindToolDefinition`/`createLsToolDefinition` and override only exposure, namespace and the renderer fields. No Pi source was copied, so no additional license payload is required; behavior tracks the pinned Pi 1.0.2 release.

The root owner must include this workspace in shared checks/tests and bundle `src/index.ts` to `dist/pi-tools/index.js`. Keep host imports external, bundle `diff@8.0.4`, and retain this module's LICENSE, NOTICE, source record and BSD license. Do not install physical host peers into the isolated runtime tree. Full compiled-loader/module-identity, six-entry discovery/filtering/coexistence and release-switch/rollback tests are root integration responsibilities, not evidence implied by the source-loader tests here.
