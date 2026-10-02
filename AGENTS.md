# Repository Guidelines

## Engineering Standards

- Keep code readable, structure and dependency direction explicit, and the repository maintainable. Add abstraction only for a current need, never for a speculative one.
- Each document owns exactly one concern: README positions the repository and its entry points; `docs/architecture.md` covers module boundaries and artifacts; `docs/development.md` covers commands, testing, isolation and release; module docs and `LICENSE`/`UPSTREAM.md` cover that module's usage, contracts and provenance.
- State the current contract only. Do not accumulate work logs, stage narratives, evidence dumps, or obsolete instructions in repository documents; delete what is no longer true instead of annotating it.

## Project Structure & Module Organization

`pi-Serraly` is a private npm workspace with six independent Pi extensions. Target Node ≥22.19 and Pi 0.99.2.

```text
.
├── modules/
│   ├── ui/                # src/index.ts, test/
│   ├── questions/         # src/, test/
│   ├── loop/              # src/, test/
│   ├── apply-patch/       # src/, test/fixtures/
│   ├── background-shell/ # src/, extensions/, tests/
│   └── docparser/         # extensions/docparser/, tests/, assets/
├── scripts/              # build.mjs, test.mjs, preview.mjs
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
- `npm run build` — produce and validate six compiled entries in `dist/`.
- `npm test` — rebuild, then run module and integration suites.
- `npm run verify` — run checks and the complete test/build pipeline.
- `node scripts/test.mjs --module loop` — debug one suite; does not replace full verification.
- `node scripts/preview.mjs regular` — preview UI with temporary data.

See `docs/development.md` for release preparation and additional commands.

## Coding Style & Naming Conventions

Use strict TypeScript and ESM. Preserve local formatting: tabs in UI/questions/loop/apply-patch; two spaces in background-shell/docparser. Retain neighboring quote styles and import extensions. Use camelCase functions/variables, PascalCase types/classes, and descriptive kebab-case filenames. Docparser uses `oxfmt` and `oxlint`; other workspaces primarily enforce TypeScript checks.

## Testing Guidelines

Tests use Node’s `node:test` runner, with `tsx` for TypeScript. Name module tests `*.test.ts` and root integration tests `*.test.mjs`. Write behavior-focused regression tests before implementation; observe failure, then success. No numeric coverage threshold is configured. Preserve boundary/compiled-artifact tests, deterministic timing, and process/worker cleanup. Run `npm run verify` before submitting; document platform skips and manually verify visual changes.

## Commit & Pull Request Guidelines

Use concise, descriptive subjects with conventional prefixes where they fit. PRs should explain affected modules, link relevant issues, report validation results, and include screenshots for UI changes. Preserve upstream licenses and provenance.

## Security & Configuration

Use isolated HOME/config/session fixtures; never access real credentials or send real model requests. Do not run `pi install .` or load development `dist/` into real settings. Deployment uses the versioned release directories, not the source tree.
