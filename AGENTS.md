# Repository Guidelines

## Working practices

- Prefer CodeGraph for code exploration, call-chain tracing, and change-impact analysis; before first use, load its deferred tool contract in `exec` with `text(ALL_TOOLS.filter(t => t.name.includes("codegraph")))`.
- Edit owning source, never installed tooling. Validate and report changes. Source edits do not update running packages.
- Trace failures through supported workflows before fixing them. A synthetic reproducer or possible interleaving alone does not prove exposure. Respect product tradeoffs; optional capabilities are not defects.
- Update documentation when behavior or usage changes. Use focused package checks while editing; run `npm run verify` for cross-package dependencies, build, installation or release tooling changes.
- Each document owns a clear concern. Keep definitions and rules in their owning document and link to them instead of duplicating them. Usage and contract docs describe current behavior, not work logs or obsolete instructions; changelogs, ADRs and issues retain their intended history.

## Branch workflow

- `dev` is for development and previews; `main` holds validated, stable changes.
- Before editing, switch to `dev` or the appropriate feature branch. Never edit or commit directly on `main`.
- Merge feature work into `dev` first. Validate the integrated result using the applicable checks and [Validation](#validation) requirements before merging into `main` at the user's request.

## Implementation principles

- Every package must work against released upstream Pi. Use supported public Pi APIs; never depend on modifying, patching or forking Pi. Report unavailable capabilities honestly.
- Use strict TypeScript/ESM and preserve each package's formatting/import style. Use public package exports, not sibling private source. Host packages are runtime peers.
- Validate unknown values once at the boundary that owns them. Pass typed values inward instead of repeating `typeof value === "object"` and property-existence checks. Do not defensively revalidate values already guaranteed by a schema, constructor, or internal type.
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid adding complexity for speculative races or security edge cases. If addressing one would materially expand scope or require a product decision from the user, explain the failure mode, likelihood and cost, and get agreement before taking on that work.
- Avoid `try` / `catch` where possible.
- Avoid using the `any` type.
- Comments explain non-obvious intent, constraints, or external API behavior. Do not restate the code, repeat repository policies, or narrate hypothetical failure scenarios. Keep shared rules in their owning document.

## Agent-facing contracts

- Agent-facing text is behavior. Keep contracts, skills, prompt metadata and subagent prompts compact. Default to general-purpose assistance; scope coding assumptions to coding tasks.
- Hide extension internals from agent-facing text, including errors. State what happened, what remains available and an actionable next step. Users own account and configuration decisions; do not invent workflow advice.
- Extend existing tools, not overlapping choices. Do not repeat obvious contracts across names, descriptions, schemas, `promptSnippet` and `promptGuidelines`. Never rewrite prior tool calls or results to integrate a tool.
- Skills and extensions must work for any user. Never ship personal names, local paths, machine assumptions or private workflows.

## Validation

- Prefer static checks or disposable probes unless the user requests a permanent test, the repository requires one, or one is needed to catch a specific regression existing tests would miss.
- Do not delete existing tests by default. When pruning, judge a test by the failure it catches and what coverage would remain, not by a contract label.
- If agents misuse tools or ignore prompts, fix the model-facing contract from real-use evidence, not programmatic tests. Tests may cover deterministic parser, executor, result and routing boundaries.
- Put editing hazards and fragile ownership/order constraints in the nearest `AGENTS.md`, not regression suites. Keep runtime validation in owning code. Test behavior, not source text, private call sequences or duplicated dependency algorithms.
- Automated checks and probes use isolated HOME/config/session and an environment allowlist. Keep them offline unless network use is explicitly authorized; registry access requires explicit dependency-installation authorization. Time/process checks need deadlines and cleanup.
- Live sandbox acceptance using real login or models requires explicit user authorization, which may be agreed during planning. Use the authorized login and models only within that scope; never expose credentials in output or evidence.
- For end-to-end sandbox acceptance, use Herdr to interact with Pi's TUI over consecutive turns that execute tools and use the guest environment. Programmatic probes do not substitute for this interaction. Refresh the guest candidate after source changes; host edits alone do not update it.
- Validate the candidate's packaged resources and bundled native helpers against released Pi without helper overrides. Report blocked or unperformed acceptance honestly.

## Installation and upstream sync

- Use a separate complete installation workspace without `.git`; keep Git history in the development repository. Prepare dependencies and artifacts through normal Bun workspace commands; register package paths with native `pi install`. Do not load the development checkout into real settings or add a custom installer/state file. Update the installation as one workspace, without per-package artifact freezing.
- Default to individual package registration. Aggregates are optional; do not load an aggregate alongside the extensions it activates.
- Real settings changes require explicit authorization, a verified backup and restore-based rollback.
- Preserve upstream licenses, binary/WASM/vendor/profiles and pinned provenance. Compare and merge upstream changes rather than overwriting intentional local behavior.
- Retained package versions track synchronized upstream baselines; local differences use Git and local changelogs. Optional aggregates have their own versions. Do not introduce Changesets or upstream npm publishing/version automation.

Issues: docs/agents/issue-tracker.md. Domain/ADRs: docs/agents/domain.md.
