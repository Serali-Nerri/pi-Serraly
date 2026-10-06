# pi-session-reference

Independent historical-session background for explicit `@session:[stable-id]` references. The entry is `dist/pi-session-reference.js`; disabling it disables only this capability. It registers no execution tools, performs no model calls, and does not depend on UI or subagents.

## Selecting a source

In the TUI, type `@session:` to search the host-managed historical catalogue by title, ID or workspace. Candidates show a terminal-safe title (at most 32 display columns), update time and workspace. Completion replaces the selected reference through its closing bracket, including any token text to the right of the cursor, with the stable ID (never a title alias). Following prose is preserved and the cursor lands immediately after the reference. All other prefixes delegate to the existing provider. Discovery refreshes on session start/loading and tree navigation. Non-TUI modes do not install autocomplete; explicit tokens still work in print, JSON, RPC and SDK requests.

Discovery uses Pi's `SessionManager.listAll`: a custom flat session directory when present, otherwise the effective agent's managed session collection across workspaces. For managed `<agentDir>/sessions/--…--/` directories, the active session path identifies the collection and discovery uses the host API in each sibling directory; it does not fall back to another agent. The current session is excluded. Tokens must match an exact catalogue ID; they are never interpreted as paths. Explicit cross-workspace selection does not load source settings, extensions, skills, instructions or authentication.

Pi 1.0.2 does not expose an SDK session's `agentDir` in `ExtensionContext`. A persisted managed session supplies that boundary via `getSessionDir()`. For an **in-memory SDK session with an explicit agent directory**, use an inline factory `pi => sessionReference(pi, { agentDir })`; otherwise the public process-level `getAgentDir()` selects the catalogue. The option is a discovery root only, not permission to load source configuration.

## Request background

For each new explicitly referencing prompt, the public `before_agent_start` hook returns one visible `session-reference` custom message. It names included sources and reports missing, deleted, unreadable, unsafe-format or excess selections without blocking healthy sources. IDs are deduplicated in first-mention order; at most five readable sources are included. The message is background belonging to that user request, not a tool call, standalone notification or new work activity. No-reference prompts and automatic retries do not append another message. Normal host history retention still applies to messages already appended.

The background is **untrusted, not authoritative instructions**. It leaves the system prompt, tool loadout, user prompt and source files unchanged. The public constant `SESSION_REFERENCE_CUSTOM_TYPE` is `session-reference`; message details identify the included sources and mark `requestBackground: true` for presentation consumers.

## Read-only projection and bounds

Pi 1.0.2's `SessionManager.open()` can initialize or migrate source files and is deliberately not used. Selected bytes are decoded as strict UTF-8, parsed with the host's exported `parseSessionEntries`, accepted only with a current-version header, and projected with `SessionManager.inMemory().buildSessionContext()`. Unsupported formats are skipped, never migrated, repaired or rewritten. The host chooses the saved effective leaf and applies branch-local context edits and compaction; the extension does not stitch trees or parse the session format itself.

Only model-context visible text, retained returned tool text, bash output and retained compaction/branch summaries are included. System messages, thinking, raw attachments, independent usage/state, hidden custom messages and off-branch text are excluded. Historical `session-reference` and `subagent-mention` custom messages are skipped; tokens in historical text are not resolved. Tool metadata and full-output paths are not followed, and existing result-truncation notices remain text. Truncated shell results reserve an explicit source-truncation warning before the retained output, outside the clipped body; reference-budget omission notices do not replace that warning or imply missing output was recovered.

UTF-8 limits include labels, metadata, wrappers and omission notices: **8,000 bytes per source message**, **24,000 per source section**, **48,000 for the complete supplemental message**. Clipping preserves valid Unicode and marks omissions. Source metadata is intentionally inspectable and may reveal a selected workspace. This is not a redaction mechanism: user-selected historical text may contain sensitive data and may be sent to the current provider.

## Lifetime and validation

The factory starts no discovery, timers or long-lived resources. Discovery and selected reads are bound to a session generation; before navigation, reload, shutdown, and subsequent starts invalidate pending work. Navigation attempts retain the unchanged active session's catalogue, so cancelled tree, switch or fork operations leave completion usable even when the host emits no after event. Completed navigation refreshes discovery; shutdown makes providers inert. Stale results cannot update candidates or inject background into another session. Cleanup is idempotent. Diagnostics are part of the bounded custom message, not protocol stdout.

Package tests use node:test/tsx with isolated real SessionManager histories, the pinned public extension factory/ExtensionRunner and a scripted provider. Run `node scripts/test.mjs --package pi-session-reference`; typecheck with `npm run check --workspace pi-session-reference`. Root artifact/load-order validation is owned by the workspace integration suite.

## Provenance

Original implementation for pi-Serraly under the MIT license. The behavior was selectively informed by `minuque/pi-cc-extensions` **v0.9.10**, commit `2b72669cafefe0771b2e3e63b0db5c478314d2d4`, `extensions/feature/reference/`. No upstream implementation is copied; title aliases, source-opening behavior and private integration are not retained. See `UPSTREAM.md` for the reference and `LICENSE` for this module's terms.
