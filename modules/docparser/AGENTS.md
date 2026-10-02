## Required validation

Original source instructions required Bun `format`, `lint` and `typecheck`.
This private workspace preserves those tool checks with root-installed dependencies:

1. `npm run format:check` (`npm run format` for deliberate formatting changes)
2. `npm run lint`
3. `npm run typecheck`
4. `npm test` (isolated unit, native, workspace/runtime validation)

Run `npm run verify` for all four and the isolated runtime import. Do not deploy,
install root dependencies concurrently, or change the read-only source reference.
Keep the original 2-space formatting and all native/business contracts. See
`UPSTREAM.md` for provenance and the build/dependency boundary.
