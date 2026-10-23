# Repository Guidelines

## Contract and document ownership

- Private Bun workspace: seven retained howaboua packages plus the independent packages/pi-ui presentation extension.
- Target Node ≥22.19, Bun 1.4.2, Pi 1.4.0. No legacy extensions/shared-library framework.
- README indexes entry points; docs/architecture.md owns dependencies/resources; docs/development.md owns commands, isolation, release and manual updates; package README/LICENSE/UPSTREAM own usage, terms and provenance; root UPSTREAM is an index.
- State current contracts, not stage narratives/work logs. Do not import upstream personal AGENTS/.pi or full-monorepo publishing workflows.

## Development

1. Update the owning document first.
2. Write a behavior-focused test at an established seam, observe failure, implement the minimum.
3. Iterate with focused checks. Inspect leftovers/contradictions and run npm run verify once at completion.
4. No compatibility layers/data migration for our legacy implementation. Retained upstream runtime contracts and operator safeguards still apply.

Strict TypeScript/ESM; preserve each package's formatting/import style. Use public package exports, not sibling private source. Host packages are runtime peers. Normal runtime dependencies and Shepherdr → agent-board are allowed.

## Commands

- bun install --frozen-lockfile --ignore-scripts — locked dependency installation.
- bun run build — package artifacts.
- bun run check — package/static/root-script checks, no build.
- bun run test -- --package pi-codex-conversion — focused isolated tests.
- npm run verify — one build, checks and all tests.
- bun run release -- --output /absolute/path/to/new-release — offline fixed-version runtime, no settings writes.

## Testing

Protect repository-owned features/adapters/configuration/isolation/lifecycle and build/release behavior through public interfaces or established seams. No duplicated dependency algorithms, tautological/change-detector tests, source assertions or private call sequences. Keep meaningful imported tests. Bug tests require a genuine coverage gap. Time/process tests need deadlines and cleanup. Qualify compiled artifacts against released Pi with synthetic providers, never real model requests. Report unavailable external-service/platform acceptance.

## Safety and provenance

Use isolated HOME/config/session and an environment allowlist. Never read real credentials or request real models. Registry access only during explicit dependency installation; checks/tests/release stay offline.
Do not pi install . or load development code into real settings. Deployment references a new immutable release with complete dependencies/resources. Real settings changes require explicit authorization, verified backup and restore-based rollback.
Preserve upstream licenses, binary/WASM/vendor/profiles and pinned UPSTREAM. Manual updates compare and merge rather than overwrite local renderer/lifecycle work.

Issues: docs/agents/issue-tracker.md. Domain/ADRs: docs/agents/domain.md.
