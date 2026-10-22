# Repository Guidelines

## Engineering Standards

- Keep code readable, structure and dependency direction explicit, and the repository maintainable.
- Each document owns exactly one concern: README positions the repository and its entry points; `docs/architecture.md` covers module boundaries and artifacts; `docs/development.md` covers commands, testing, isolation and release; module docs and each `LICENSE` cover that module's usage, terms and provenance; root `UPSTREAM.md` indexes the retained external upstreams.
- State the current contract only. Do not accumulate work logs, stage narratives, evidence dumps, or obsolete instructions in repository documents; delete what is no longer true instead of annotating it.

## Development Cycle

This is an internal, in-progress project: no backward compatibility and no data migration. Rewrite legacy formats, interfaces and behavior into the current ideal KISS implementation instead of adding compatibility layers, transition paths or migration code for this repository's own code and state. The operator safeguards in "Security & Configuration" and the retained-upstream conventions in module docs still apply.

Each change follows this order:

1. **Update documents first.** Update the owning document before the code, and confirm it holds no contradiction or stale statement.
2. **Write the test first.** Follow TDD: write the behavior-focused test, observe it fail, then implement. See "Testing Guidelines" for what not to test.
3. **Implement the minimum.** Write only what the current contract requires; no speculative abstraction.
4. **Close the loop.** Run focused tests during iteration; after the complete change, confirm there is no leftover code, duplicated source of truth or document/implementation contradiction, then run `npm run verify` once. Do not repeat full verification per subtask or commit.

## Project Structure & Module Organization

`pi-Serraly` is a private npm workspace with one independent Pi extension. Target Node ≥22.19 and Pi 1.3.0.

```text
.
├── extensions/
│   └── pi-ui/                 # src/, test/, dist/ (built)
├── packages/             # shared build-time libraries (no Pi entry point)
├── scripts/              # check, build, test, pack:check, release and lib/
├── test/integration/     # *.test.mjs, fixtures/
├── docs/                 # architecture.md, development.md
├── package.json
└── package-lock.json
```

Follow module-local `AGENTS.md` instructions. Keep the entry point independent; UI owns presentation, not business execution.

## Build, Test, and Development Commands

Run from the repository root:

- `npm ci --ignore-scripts --include=optional --legacy-peer-deps` — install locked dependencies.
- `npm run check` — run each package's check and root-script syntax checks against already-built library declarations.
- `npm run build` — build and seal every package artifact in its own `dist/`.
- `npm test` — run package and integration suites using existing artifacts; no implicit build.
- `npm run pack:check` — verify existing sealed artifacts without rebuilding.
- `npm run verify` — build once (including artifact validation), then check and run all suites.
- `npm run build && npm run release && pi install "$HOME/.local/share/pi-Serraly/releases/$(node -p 'require("./package.json").version')"` — build, seal a release directory and install it into Pi; after a version change, `pi remove` the previous release path.
- `node scripts/test.mjs --package pi-ui` — debug one package; does not replace full verification.
- `node scripts/preview.mjs regular` — preview UI with temporary data.

Every root entry point refuses to start below Node 22.19.0 (`scripts/lib/node-version.mjs`);
this repository has no CI workflows. Local acceptance uses the actual managed Pi host/runtime; the
22.19 lower bound is a startup constraint, not a mandatory local compatibility matrix.
Registry access belongs to the dependency-install phase only.

See `docs/development.md` for release preparation and additional commands.

## Coding Style & Naming Conventions

Use strict TypeScript and ESM. Preserve local formatting: tabs in UI. Retain neighboring quote styles and import extensions. Use camelCase functions/variables, PascalCase types/classes, and descriptive kebab-case filenames.

## Testing Guidelines

- Tautological tests considered harmful.
- Change-detector tests considered harmful.
- Do not create regression tests for bug fixes without a genuine gap in behavior testing.
- Test behavior this repository owns: extension features, adapters, configuration and security rules, lifecycle/resource cleanup, and build/release artifacts. Exercise public interfaces or established seams, with independently derived expectations.
- Do not duplicate upstream tests for Pi, TypeBox, Node or other dependencies. Upstream algorithms, resource limits, and API semantics belong in their owning repositories; investigate them with disposable probes when needed, not permanent local tests.
- Retain integration tests that exercise our code against the real host or compiled artifacts and catch a concrete failure in our adapter, admission/isolation policy, packaging or lifecycle. Merely calling an upstream API and asserting its documented result is not a local integration contract.
- Before adding or retaining a test, identify the repository-owned behavior it protects. Remove upstream-only, tautological, change-detector and redundant cases; do not replace them with assertions on source text, private call sequences or dependency version constants. Host qualification and package metadata gates remain repository-owned behavior.

Root integration and package tests use Node’s `node:test` runner, with `tsx` for TypeScript. Name package tests `*.test.ts` and root integration tests `*.test.mjs`. When a regression test is warranted, write a behavior-focused test before implementation; observe failure, then success. No numeric coverage threshold is configured. Preserve boundary/compiled-artifact tests, deterministic timing, and process/worker cleanup. Run `npm run verify` before submitting; document platform skips and manually verify visual changes.

## Commit & Pull Request Guidelines

Use concise, descriptive subjects with conventional prefixes where they fit. PRs should explain affected modules, link relevant issues, report validation results, and include screenshots for UI changes. Preserve upstream licenses and provenance.

## Security & Configuration

Use isolated HOME/config/session fixtures; never access real credentials or send real model requests. Do not run `pi install .` or load development `dist/` into real settings. Deployment references one immutable versioned release directory. Changing real settings requires explicit authorization, a verified settings backup and a restore-based rollback.

## Agent skills

### Issue tracker

Issues and specs live as local markdown under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout: root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
