---
{
  "doc_id": "commands/bg",
  "covers_sources": [],
  "covers_surfaces": [
    "command:bg"
  ]
}
---
# `/bg`

`/bg [--survive-reload] [--name <name>|-n <name>] [--] <command>`

`--name=<name>` and `-n=<name>` are accepted; quoted names are parsed before the remaining bytes become shell command text. An omitted name is derived from the command. Empty commands and missing/unterminated names fail. Only one bare `--survive-reload` is accepted; duplicate or assignment forms fail.

Returns a task ID and output path after spawning. Notification defaults on; automatic steering/wake-up defaults off. Reload survival defaults off.

```text
/bg --name "Build" npm run build
/bg --survive-reload --name "Watcher" npm run watch
/bg --name "Server" -- npm run dev -- --host 127.0.0.1
```

Removed classification options `--agent`, `--llm-agent`, `--script`, `--no-agent` are rejected **only in extension option positions**. After `--`, or after command text begins, child options are never scanned or classified. A user-written `pi ...` is just another shell command: no wrapping, model selection, authentication, or telemetry.

All launches use the [activation-selected shell](../operations/configuration.md), local permissions and cwd; they are not sandboxed. See [same-process reload](../subsystems/background-task-runtime.md) and [completion delivery](../concepts/completion-delivery.md).
