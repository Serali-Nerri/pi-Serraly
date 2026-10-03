# Repository Guidelines

## Engineering Standards

- Keep code readable, structure and dependency direction explicit, and the repository maintainable. Add abstraction only for a current need, never for a speculative one.
- Each document owns exactly one concern: README positions the repository and its entry points; `docs/architecture.md` covers module boundaries and artifacts; `docs/development.md` covers commands, testing, isolation and release; module docs and `LICENSE`/`UPSTREAM.md` cover that module's usage, contracts and provenance.
- State the current contract only. Do not accumulate work logs, stage narratives, evidence dumps, or obsolete instructions in repository documents; delete what is no longer true instead of annotating it.

## Development Cycle

This is an internal, in-progress project: no backward compatibility and no data migration. Rewrite legacy formats, interfaces and behavior into the current ideal KISS implementation instead of adding compatibility layers, transition paths or migration code for this repository's own code and state. The operator safeguards in "Security & Configuration" and the upstream conventions in module docs still apply.

Each change follows this order:

1. **Update documents first.** Update the owning document before the code, and confirm it holds no contradiction or stale statement.
2. **Write the test first.** Follow TDD: write the behavior-focused test, observe it fail, then implement. See "Testing Guidelines" for what not to test.
3. **Implement the minimum.** Write only what the current contract requires; no speculative abstraction.
4. **Close the loop.** Confirm there is no leftover code, no duplicated source of truth and no document/implementation contradiction, then run `npm run verify`.

## Project Structure & Module Organization

`pi-Serraly` is a private npm workspace with seven independent Pi extensions. Target Node ≥22.19 and Pi 1.0.0.

```text
.
├── modules/
│   ├── ui/                # src/index.ts, test/
│   ├── questions/         # src/, test/
│   ├── loop/              # src/, test/
│   ├── tools/             # src/, test/fixtures/
│   ├── background-shell/ # src/, extensions/, tests/
│   ├── add-dir/           # src/, test/
│   └── subagents/         # src/, test/ (Vitest)
├── scripts/              # check, build, test, release entry points and lib/
├── test/integration/     # *.test.mjs, fixtures/
├── docs/                 # architecture.md, development.md
├── package.json
├── package-lock.json
└── dist/                 # generated development artifacts
```

Follow module-local `AGENTS.md` instructions. Keep entry points independent; UI owns presentation, not business execution.

## Build, Test, and Development Commands

Run from the repository root:

- `npm ci --ignore-scripts --include=optional --legacy-peer-deps` — install locked dependencies.
- `npm run check` — run workspace checks and root-script syntax checks.
- `npm run build` — produce and validate seven compiled entries in `dist/`.
- `npm test` — rebuild, then run module and integration suites.
- `npm run verify` — run checks and the complete test/build pipeline.
- `node scripts/test.mjs --module loop` — debug one suite; does not replace full verification.
- `node scripts/preview.mjs regular` — preview UI with temporary data.

See `docs/development.md` for release preparation and additional commands.

## Coding Style & Naming Conventions

Use strict TypeScript and ESM. Preserve local formatting: tabs in UI/questions/loop/tools; two spaces in background-shell/subagents. Retain neighboring quote styles and import extensions. Use camelCase functions/variables, PascalCase types/classes, and descriptive kebab-case filenames.

## Testing Guidelines

- Tautological tests considered harmful.
- Change-detector tests considered harmful.
- Do not create regression tests for bug fixes without a genuine gap in behavior testing.

Root integration and most module tests use Node’s `node:test` runner, with `tsx` for TypeScript. Subagents retains its imported Vitest suites and runs through the same isolated root runner with network denial. Name module tests `*.test.ts` and root integration tests `*.test.mjs`. When a regression test is warranted, write a behavior-focused test before implementation; observe failure, then success. No numeric coverage threshold is configured. Preserve boundary/compiled-artifact tests, deterministic timing, and process/worker cleanup. Run `npm run verify` before submitting; document platform skips and manually verify visual changes.

## Commit & Pull Request Guidelines

Use concise, descriptive subjects with conventional prefixes where they fit. PRs should explain affected modules, link relevant issues, report validation results, and include screenshots for UI changes. Preserve upstream licenses and provenance.

## Security & Configuration

Use isolated HOME/config/session fixtures; never access real credentials or send real model requests. Do not run `pi install .` or load development `dist/` into real settings. Deployment references one immutable versioned release directory. Keep the `subagents-lite.json`, `subagents-lite-prompt.md` and `agents/*.md` config filenames. Changing real settings requires explicit authorization, a verified settings backup and a restore-based rollback.
