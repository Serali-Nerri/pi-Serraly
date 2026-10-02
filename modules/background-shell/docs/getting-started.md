---
{
  "doc_id": "getting-started",
  "covers_sources": [],
  "covers_surfaces": []
}
---
# Background shell quick start

Use `/bg --name "Build" npm run build`, inspect with `/jobs` or `/logs <id>`, and stop with `/kill <id>`. `/tasks` opens the TUI dock. Default `/bg` completion is display-only; default `bg_run` completion also starts a follow-up turn. Do independent work or end the turn instead of polling for completion.

Tools are deferred in the `background-shell` namespace. Keep the host's built-in `tool_search` enabled (root settings retain `defaultTools: ["+tool_search"]`); the module does not alter the host loadout. Commands and shortcuts do not depend on tool discovery.

This is a private npm workspace module, not a separate installation target. Follow the repository root docs for installation, runtime staging and migration. For isolated development verification, see [TESTING](../TESTING.md); its scripts never change global settings. The source factory is `extensions/background-tasks.ts` → `src/extension.ts`; the compiled module entry is `dist/extensions/background-tasks.js`. The root package exposes it through `dist/pi-background-shell/index.js` with the full compiled closure.

Do not load the old fork or upstream alongside this entry: tool and command names overlap. Stop old tasks before switching; same-process ownership cannot adopt upstream or restarted processes. Verification targets Pi 0.99.2; Windows/PTY limitations are explicitly recorded in TESTING.

See [configuration](operations/configuration.md), [runtime limits](subsystems/background-task-runtime.md), [completion delivery](concepts/completion-delivery.md) and [tool schemas](tools/bg_run.md).
