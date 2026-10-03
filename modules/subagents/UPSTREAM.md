# Upstream

- Project: [AlexParamonov/pi-subagents-lite](https://github.com/AlexParamonov/pi-subagents-lite)
- Version: `1.15.1`
- Commit: `0a9ad2f14562daeec2b5d815fbdf42695f2e7f11`
- License: MIT; the original `LICENSE`, including its copyright notice, is preserved verbatim.

The source and behavior tests are maintained as an independent module of this
private workspace, not published on a separate npm release line. Runtime host
packages remain external peers; the supported development baseline is Pi 1.0.0,
TypeBox 1.3.27 and the repository's strict TypeScript. The imported Vitest suites
run through the common isolated runner.

## Maintained differences

- User configuration, prompts, skills and transcript output respect Pi's agentDir
  and the runtime temporary directory. Target settings and project resources
  follow the parent/target trust decision rather than implicitly trusting a
  same-repository child.
- Child sessions select enabled extensions before factories execute, defaulting
  general-purpose to native codemode, tool-search and MCP. The module supplies
  the host's native SDK factories, preserves settings-disable priority, and
  does not implicitly load sibling modules.
- SDK registry admission and exact exclusions protect direct and nested calls
  without freezing inherited tools to a startup snapshot. Existing static
  extension selectors are retained; unsupported dynamic MCP wildcard
  restrictions fail closed. Agent control tools and child-context registrations
  cannot enable recursive subagents.
- Session ownership begins at allocation. Idempotent asynchronous shutdown waits
  for startup, emits session_shutdown and disposes owned sessions on Clear,
  parent shutdown or failed initialization. Normal completion/Stop and widget
  retention preserve continuation semantics and retained native connections.
- Terminal widgets/viewers are confined to TUI. Dedicated tool renderers and the
  public subagent-result message renderer remain owned by this module.

Configuration and usage are documented in [README.md](README.md); workspace
build, runtime-only artifacts and release operations belong to the root docs.
