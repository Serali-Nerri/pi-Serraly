---
{
  "doc_id": "subsystems/extension-lifecycle",
  "covers_sources": [
    "extensions/background-tasks.ts",
    "src/extension.ts",
    "src/core/lazy-module.ts"
  ],
  "covers_surfaces": []
}
---
# Extension lifecycle and lazy UI

The module factory entry is `dist/extensions/background-tasks.js`, compiled from `extensions/background-tasks.ts` reexporting `src/extension.ts`. The root package adds a thin `dist/pi-background-shell/index.js` wrapper and keeps this complete compiled module closure; installation/release wiring belongs to root scripts. Four tools (deferred exposure, namespace `background-shell`) and seven commands are registered; only the selected dock shortcut is conditional. The completion renderer is `background-task-notification`.

A synchronous close fence blocks admission, closes the lazy dock lane and clears open UI before async cleanup. LazyModule is activation-local, single-flight, and remains closed after shutdown; failed imports are bounded errors. Static startup must not import `src/ui/background-tasks-manager.ts`; its literal deferred target ships in both source and dist closure. No eager UI load before dock use.

Task-change and periodic footer updates isolate presentation failures from child ownership. Non-stale UI errors are reported once per failure burst, without failing an admitted process or throwing from an interval. Stale contexts close the UI lane; actual launch, storage, or termination failures remain errors.

## SDK embedding

The supported development baseline is Pi 1.0.0. An SDK host must call `bindExtensions()` with counted bindings, for example `{ onError, ... }`, and provide the normal `session_start` after reload. Empty/mode-only binding is not a supported handoff path. Dispose through `AgentSessionRuntime.dispose()` or another awaited host lifecycle that emits `session_shutdown`; direct `AgentSession.dispose()` does not emit the awaited shutdown event needed for child cleanup. Rebind session-local subscriptions and extension bindings after runtime session replacement.

Normal TUI/RPC/print/JSON modes supply lifecycle bindings. Reload is a live same-process handoff, not reconstitution from metadata. See [runtime](background-task-runtime.md), [testing](../../TESTING.md) and [gate design](docs-freshness-gate.md).
