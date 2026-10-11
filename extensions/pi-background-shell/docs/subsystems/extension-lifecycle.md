---
{
  "doc_id": "subsystems/extension-lifecycle",
  "covers_sources": [
    "extensions/background-tasks.ts",
    "src/extension.ts",
    "src/core/lazy-module.ts",
    "src/ui/tool-cards.ts"
  ],
  "covers_surfaces": []
}
---
# Extension lifecycle and lazy UI

The module factory entry is `dist/extensions/background-tasks.js`, compiled from `extensions/background-tasks.ts` reexporting `src/extension.ts`. The root package adds a thin `dist/pi-background-shell/index.js` wrapper and keeps this complete compiled module closure; installation/release wiring belongs to root scripts. Four tools (deferred exposure, namespace `background-shell`) and seven commands are registered; only the selected dock shortcut is conditional. The completion renderer is `background-task-notification`.

Tool cards use the shared card syntax. `src/ui/tool-cards.ts` is the only module that imports `pi-ui-kit`, and the only one the build bundles: `tsc` compiles the runtime one-to-one, then the shared package builder inlines that leaf (kit included, host packages external) into the same `dist/src/ui/tool-cards.js` with a multi-source map. The manifest declares that leaf under `serraly.build.bundles`; the docs gate allows the declared workspace packages there and nowhere else, and still rejects a bare workspace import in the compiled closure. The leaf renders card chrome from plain display input and never reads the registry, configuration or extension factory.

A synchronous close fence blocks admission, closes the lazy dock lane and clears open UI before async cleanup. LazyModule is activation-local, single-flight, and remains closed after shutdown; failed imports are bounded errors. Static startup must not import `src/ui/background-tasks-manager.ts`; its literal deferred target ships in both source and dist closure. No eager UI load before dock use.

Task-change and periodic footer updates isolate presentation failures from child ownership. Non-stale UI errors are reported once per failure burst, without failing an admitted process or throwing from an interval. Stale contexts close the UI lane; actual launch, storage, or termination failures remain errors.

## SDK embedding

The supported development baseline is Pi 1.1.0. An SDK host must call `bindExtensions()` with counted bindings, for example `{ onError, ... }`, and provide the normal `session_start` after reload. Empty/mode-only binding is not a supported handoff path. Dispose through `AgentSessionRuntime.dispose()` or another awaited host lifecycle that emits `session_shutdown`; direct `AgentSession.dispose()` does not emit the awaited shutdown event needed for child cleanup. Rebind session-local subscriptions and extension bindings after runtime session replacement.

Normal TUI/RPC/print/JSON modes supply lifecycle bindings. Reload is a live same-process handoff, not reconstitution from metadata. See [runtime](background-task-runtime.md), [testing](../../TESTING.md) and [gate design](docs-freshness-gate.md).
