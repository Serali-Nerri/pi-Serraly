# pi-codex-conversion

If you're expecting details about the code, you've come to the wrong place. Clone it and ask your Clanka.

Pi already runs GPT models. This extension gives them Codex-shaped tools and prompt handling, then adds voice, compaction and OpenAI controls without turning the provider request into a schema landfill.

For the argument and token numbers, read [How I gave Pi 17 tools without loading 17 schemas](https://howaboua.dev/writing/how-i-gave-pi-17-tools-without-loading-17-schemas/). This README is for using the thing.

## What you get

- Codex-shaped shell, patch and image tools
- tools exposed directly, composed in one-shot code, or used through persistent Deno and TypeScript notebooks
- foreground, background and interactive shell sessions with resumable output
- image descriptions for blind models
- realtime voice, push-to-dictate and a remote voice interface for your phone or browser
- OpenAI reasoning, verbosity, fast mode, cache controls, usage and compaction
- compact Pi-native rendering, status and background-shell controls

Pi keeps its sessions, project context, skills and UI. The model gets the dialect it already knows.

Install [Imagegen](../pi-codex-imagegen) for image generation. Web search is an external extension, not part of this repository.

## Install

Prepare the installation workspace as described in [development](../../docs/development.md#本地安装工作区), then register its package path:

```bash
pi install ~/.pi/pi-Serraly/packages/pi-codex-conversion
```

Requires Pi 1.5.0 or newer and Node.js 22.19 or newer. Native helpers for macOS, Linux and Windows are bundled for x64 and arm64. TS Notebook has [narrower platform support](#code-mode-and-custom-tools).

Open `/codex` after installation. Codex-like GPT models use **Structured** mode by default.

**My recommended setup:** select **Notebook** under **General**, enable **Heavy system prompt overwrite**, and choose **Codex V2** compaction under **Context**. These are opt-in, but they're what I'm daily-driving and fine-tuning towards.

## Reference

<a name="modes"></a>

<details>
<summary><strong>Modes</strong></summary>

Choose an execution mode under `/codex` → **General**:

| Mode | How the model uses tools |
| --- | --- |
| **Structured** | Calls tools directly through top-level JSON schemas. |
| **Code** | Composes tools in one-shot JavaScript cells through `exec`, with `wait` for longer work. |
| **Notebook** | Uses a persistent Deno notebook with JavaScript and TypeScript support. |
| **TS** | Uses a persistent TypeScript notebook with strict checking before execution and Node APIs. |
| **QuickJS Code** | Composes tools in fresh JavaScript environments, with up to four concurrent cells. |

Code and QuickJS Code start fresh for each cell. Notebook and TS retain state between cells and provide notebook management controls. They differ in runtime access and what can be restored after a restart. See [execution modes](#code-mode-and-custom-tools) below.

All PCC tools register inactive by default and are enabled by the selected mode or settings. Conversation-tree navigation does not automatically enable tools never declared on the selected branch. Pi's explicitly recorded tool state is still preserved; selecting a mode or changing settings updates the active loadout at the normal runtime boundaries.

Execution mode is separate from provider scope. Apply the adapter to **Codex and configured** providers or **all providers**. **Extra tools only** adds selected patch and image tools without replacing the normal setup. **Voice only** keeps voice and dictation without changing the model's tools or requests.

The Codex toolset reads files through the shell and edits with `apply_patch`, rather than Pi's separate text read, edit and write tools.

Background shells survive context compaction and Notes rollover. The agent receives a fresh shell inventory without changing the standing prompt. If a command finishes with an uncollected result, PCC wakes the agent only when idle. Normal monitoring remains primary; these notices are a safety net.

</details>

<a name="settings"></a>

<details>
<summary><strong>Settings</strong></summary>

`/codex` saves changes immediately. Changes made during a run apply after it settles. Voice stop, mute and server controls remain immediate.

| Tab | Covers |
| --- | --- |
| General | Settings scope, execution mode, providers, prompt overwrite, time reminders |
| Context | Compaction method and retained user messages |
| Tools | Auto reasoning, image descriptions, standalone tools |
| OpenAI | Fast and Ultrafast modes, Daybreak, verbosity, transport, diagnostics, Responses Lite |
| Display | Statusline, tool rendering, note save markers, background shells |
| Voice | Realtime voice, remote access, summarisation, dictation, shortcuts, prompt paths |
| Usage | Spend by model and reset window, Codex limits, reset credits |
| About | GitHub, changelog, Discord, issues |

Open a tab directly with commands such as `/codex tools`, `/codex openai` or `/codex voice`.

### Global or project settings

The first setting chooses **Global** or **This project**. Global settings live in `~/.pi/agent/pi-codex-conversion.json`. Project settings create a snapshot at `.pi/pi-codex-conversion.json`, read only in trusted folders.

Switching back to Global removes the project's overrides. Run `/reload` after editing configuration files by hand.

### Optional controls

- **Heavy system prompt overwrite:** **on** trims Pi's default instructions while preserving other extensions' additions. **GPT (experimental)** uses denser guidance. Off by default.
- **Current time reminders:** adds periodic time updates for the model. Choose 30 or 60 minutes under General. Off by default.
- **Auto reasoning:** asks supported GPT-6 models to adjust effort during work, never below your selected level. Your selection returns when the run settles. Off by default. The model can ignore the instruction, so this is not a guarantee of adaptive effort.
- **Fast Mode:** choose off, priority processing or Ultrafast independently for Astra, Sol, Terra and Luna. Availability depends on the model and account.
- **Daybreak:** requests the connected account's available Daybreak access program without changing the selected model. Requests stop if support cannot be confirmed. See [OpenAI's Daybreak guide](https://developers.openai.com/api/docs/guides/daybreak).

### Usage and quota

`/codex usage` shows recorded tokens, API-equivalent spend, Codex limits and reset credits. These dollar values are estimates, not subscription charges. Quota shares are approximate because other apps and devices can use the same allowance. Renamed providers and custom endpoints carry an accuracy warning.

`/codex usage analyse` asks your agent to inspect longer-term trends and reasoning levels. Tracking is local and stores no conversation content. The first view imports available session costs, but cannot recover missing calls or exact historical reset times.

When ordinary quota runs out, eligible accounts may receive **Luna Reserve**. PCC switches only after backend authorisation and asks you to send `continue`. It does not redeem reset credits automatically. Your original model returns after ordinary quota recovers, unless you choose another model first.

</details>

<a name="context-management"></a>

<details>
<summary><strong>Context management</strong></summary>

Choose under `/codex context`:

| Method | What survives compaction |
| --- | --- |
| **Pi summary** | A readable summary. Default. |
| **Codex V2** | An encrypted OpenAI checkpoint and recent user messages. |
| **Both** | The checkpoint plus a readable summary, at extra summarisation cost. |

V2 can preserve 16k, 32k or 64k of recent user messages verbatim. The default is 64k. This is not the total context limit.

V2 and Both require Codex or a configured compatible passthrough. **Choose Both before creating a checkpoint you need across providers, or convert to Pi summary before switching.** Other routes use Pi summary without erasing your saved method.

For notes, history, context-window rollover and shared agent context, install [Notes Compaction](../pi-notes-compaction/README.md) and configure it under `/notes`. These are not built into PCC. Existing Notes-enabled PCC configurations require Notes to be loaded or that old continuity setting to be explicitly disabled.

</details>

<a name="cache-diagnostics"></a>

<details>
<summary><strong>Cache and diagnostics</strong></summary>

Pi's footer shows cache percentage. Enable **Codex diagnostics** under `/codex openai` for connection status:

| Status | Meaning |
| --- | --- |
| `HIT • WS delta` | Cached input reported and only continuation input sent |
| `HIT • WS full` | A full request was needed, but the prompt cache still hit |
| `MISS` | No cached input reported |
| `WS retry` | Retrying the WebSocket connection |
| `WS → SSE` | Switched to SSE after WebSocket recovery |

**Prompt caching and WebSocket continuation are separate.** A full request can still hit the cache.

**Status + log** writes diagnostic files to `~/.pi/agent/pi-codex-logs/`. They include usage, timings, retries and safe error metadata, but exclude prompts, tool arguments, images and credentials. These logs are useful when reporting a problem.

**Request timeouts follow Pi.** Normal requests have no default response-header or stream-idle deadline. A caller's positive `timeoutMs` limits SSE response headers or WebSocket idle waits; zero disables it. SSE body streaming has no idle timeout. Stalled requests can therefore wait longer and may need manual cancellation. Existing recovery budgets and WebSocket setup/prewarm deadlines still apply.

**Keepalive uses quota while idle and does not guarantee cache retention.** It is off by default. Astra, Sol and Terra offer per-project request intervals of 25 or 55 minutes. Luna has a global duration of 5, 10 or 15 minutes, with requests every 2.5 or 4.5 minutes until that duration expires.

</details>

<a name="code-mode-and-custom-tools"></a>

<details>
<summary><strong>Execution modes and custom tools</strong></summary>

Code and Deno download their runtimes on first use. TS and QuickJS Code reuse matching installed packages or download them with npm. First use needs registry access when packages are missing. Cached runtimes work offline, and unselected modes do not download anything.

In Notebook and TS modes, ask your agent to inspect, save, load or clean up notebook state. The `notebook` tool provides its own action help. **Restart and cancellation do not undo file changes or other external tool effects.**

### Deno Notebook

The **Notebook** setting provides persistent JavaScript and TypeScript with Deno APIs, imports, checkpoints, project pins and named profiles. It also supports startup and tool-result hooks for reusable automation.

After a normal cell yields, `isolated:true` cells can run in separate Deno kernels from the last completed checkpoint. Up to four isolated cells can run at once. They save named profile candidates without changing live state. Loading a candidate adds its saved bindings and rejects name collisions, rather than replacing the notebook. Only checkpoint-supported state transfers. Recreate imports, closures and live handles when needed.

### TS Notebook

Select **TS** for strict TypeScript checking, retained type declarations, Node and Web APIs, and imports from local files or packages. Invalid code and tool arguments are rejected before execution. New npm dependencies require user approval.

Run Pi under Node on Linux or macOS with x64 or arm64, or Windows x64.

Variables, closures, class instances and module state survive between cells. Checkpoints save supported data and helpers, reporting anything that remains live-only. Custom snapshot and restore helpers can preserve additional objects. Restart restores the checkpoint, not arbitrary live-only state.

Conversation-tree navigation starts a new TS notebook session rather than replaying earlier cells. Unpinned session bindings are not restored from the selected transcript; project pins and saved profiles remain separate. This does not undo external tool or file effects. Pi's historical tool activation state is still restored independently.

Concurrent isolated cells start from the last checkpoint and save separate candidates. Loading one replaces the live notebook rather than automatically merging changes. Releasing bindings also rebuilds the kernel and clears live-only values.

### QuickJS Code

Select **QuickJS Code** to compose tools in JavaScript. Each call starts fresh, with up to four cells running concurrently. Variables and closures do not carry between calls. Use `store` and `load` for conversation-local JSON data that does not persist to disk.

The store resets when the runtime is recreated, including session changes and conversation-tree navigation. Each cell reads a starting snapshot. Writes take effect immediately and are not rolled back on failure; concurrent writes to the same key are last-write-wins.

Run Pi under Node. The environment has no Node APIs, imports, direct network access, timers or TypeScript checking. The agent uses tools for host operations.

QuickJS Code replaces JS Notebook. Existing `js` settings select QuickJS Code. Old notebook files are left untouched but are not loaded. There are no checkpoints, profiles, project-shared variables or `notebook` controls in this mode.

### Extension tools and MCP

Installed Pi tools and enabled MCP servers are available inside Code, QuickJS Code and both notebook modes. Configure MCP servers through Pi. Existing permissions, tool restrictions and disabled servers still apply.

Deferred-tool announcements group tools by their declared namespace, falling back to the registering extension when Pi provides a file source. Groups and tools are ordered by name. Calls remain flat (`tools.web_search(args)`), and full contracts remain in `ALL_TOOLS`. New announcements use this layout; earlier messages are not rewritten or re-announced just to regroup them.

Use `content(result.content)` to emit mixed MCP text and images in their original order. The helper also accepts a single content block. Resource blocks remain JSON text; audio and encrypted text are not supported.

`exec` and `wait` wait for their active Pi tool calls to return before yielding, even when the cell's yield timeout has elapsed.

If a server is still connecting, the agent may need to retry its call. Use **Ctrl+O** to expand or collapse tool details, or click individual notices in fullscreen mode.

### Tool cards

`exec` and `wait` retain the upstream renderers and Pi's themed pending/success/error card shell. With **Code / Notebook details** enabled, the script previews its first 3 source lines and shows the tool-name summary extracted from source. Nested calls retain their own call and result renderers, including friendly command naming. Completed console output previews its last 5 visual lines; partial output follows upstream streaming. Patch calls retain the original renderer and pre-execution diff cache.

In fullscreen mode, click the script, console output or an individual nested call to expand it independently, including repeated calls to the same tool. Clicking a patch affects all files in that call, not other calls. A completed nested call can be collapsed while the surrounding script continues running. **Ctrl+O** controls the whole card and clears local choices when the global expansion changes. Resize, streaming updates, notifications without a trace snapshot and theme repaint preserve local choices. Explicit snapshots discard choices only for calls no longer present. Drag selection, links and child mouse handlers remain host-owned.

Nested `view_image` calls show only their title and path, plus errors if any; they never draw images or retain hidden raw results in the nested render cache. Images explicitly emitted through `image(...)` are displayed once by Pi below the card. This is a UI rule, not image deduplication or a change to model-visible content.

Top-level `view_image` calls also leave result images to Pi, avoiding a second copy inside the card. For text-only models, the optional description fallback keeps its preview inside the card and respects Pi's image-display setting.

The `/codex` → **Display** controls keep their upstream behavior and defaults. **Code / Notebook details** is off by default. **Compact tool output → On** hides collapsed patch diffs; **Minimal** also replaces collapsed console previews with an expand hint. Local clicks do not bypass disabled details. Expansion cannot recover traces, output or historical diffs that the producer no longer retains.

### Custom commands

Command-backed tools use TOML definitions in either location:

```text
~/.pi/agent/codex-conversion-custom-tools/
<project>/.pi/codex-conversion-custom-tools/
```

See the [working examples](./examples/custom-tools/) and [definition contract](./src/tools/code-mode/CUSTOM-TOOLS.md). For on-demand skill discovery, use a separate skills extension.

</details>

<a name="voice-dictation-and-remote-access"></a>

<details>
<summary><strong>Voice, dictation and remote access</strong></summary>

Choose **Voice model** in `/codex voice` or the browser interface. Voice runs independently of the active text model.

| Voice model | Credential |
| --- | --- |
| `codex-live-1.1`, the default | Pi's legacy `openai-codex` login, or a configured gateway provider |
| `realtime-2.1` | An API key for the selected Realtime-compatible Pi provider |
| `realtime-2.1-mini` | An API key for the selected Realtime-compatible Pi provider |

Codex Live and dictation default to OAuth through `/login openai-codex`.

**Codex Live gateways.** Set these fields in `/codex voice` or the LAN voice settings:

- **Codex Live provider** (`voice.codexLiveProvider`): the exact Pi provider ID supplying the gateway API key and headers. If only a base URL is set, the provider defaults to `openai-codex`.
- **Codex Live base URL** (`voice.codexLiveBaseUrl`): the HTTP(S) base before `/realtime/calls`. Blank uses the selected provider's endpoint. For CLIProxyAPI, use a base such as `http://127.0.0.1:8317/v1`, not the chat route's `/backend-api` base.

Leave both fields blank to use the default Codex login route. Gateway access requires an API key, not a Pi OAuth login, and does not fall back to another route on failure. Invalid strings are retained for correction and rejected at call startup. Changing voice access does not change dictation's login.

**Public Realtime.** Enter the exact, case-sensitive Pi provider ID in **API provider**; the default is `openai`. Realtime uses that provider's API key, headers and compatible endpoint without storing or displaying the key. Missing keys, OAuth credentials and invalid endpoints are rejected without falling back to another account. Changes apply on the next call. Official OpenAI Realtime API usage is billed separately from ChatGPT subscriptions; gateway access and billing depend on its provider. Sign in with ChatGPT does not supply public Realtime API access.

Codex Live rewrites the current voice conversation interval into a self-contained task before sending it to Pi. **Task delegation model** shows the configured model without a picker. Change `voice.taskDelegationModel` in the JSON configuration to use another `provider/model` value. The default is `openai-codex/gpt-6-luna`. Choose **Task delegation reasoning** separately in terminal or LAN settings. It defaults to `low` and is independent of voice context summarisation. These settings apply only to Codex Live; GPT-Realtime still sends tasks directly through `send_task`.

Realtime models use `send_task` to send Pi a self-contained task with relevant voice-discussion decisions and constraints. Busy Pi sessions receive it as steering, with existing tools and confirmations preserved. Realtime models can also use developer-registered voice tools. For optional search, load `@howaboua/pi-codex-web-run`, configure its access and enable **Realtime web search**. Search uses Web Run's configured provider and credentials.

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+Space` | Toggle realtime voice |
| `Ctrl+Alt+M` | Mute or unmute |
| `Ctrl+Alt+D` | Push-to-dictate. Toggle behaviour is available in the Voice tab |
| `Ctrl+Alt+G` | Toggle the remote voice server |

Audio follows system defaults. Select devices under Voice if needed. Dictation puts an editable transcript in Pi's input.

Choose primary and alternate voices in the Voice tab or browser interface. Codex Live and Realtime keep separate voice choices, defaulting to Cove and Ember for Codex Live, Marin and Cedar for Realtime. Model and voice changes apply to the next call without replacing the current call. With Shepherdr, transferring voice to another session alternates the voice and gives an arrival greeting. **Refresh voice context** summarises and restarts voice after rollover or compaction.

Customise the voice prompt at `~/.pi/agent/REALTIME-SYSTEM-PROMPT.md`. Trusted projects can append `.pi/REALTIME-SYSTEM-PROMPT.md`. Your custom prompts are not rewritten automatically.

### Use voice from another device

**The remote server has no authentication. Keep it on a trusted network.**

Run `/codex voice server`, open its HTTPS address on your phone or another computer, and accept the local certificate. The browser provides voice, mute, editable dictation, typed prompts and Pi activity. Moving between devices does not restart the host's voice call.

For automation, use `/codex voice server ensure` to start the listener only if needed, or `/codex voice server status` to inspect it without changing it. The bare `/codex voice server` command remains a toggle. Starting the listener does not start a voice call.

Append a UUID v4 to either explicit command to write a JSON receipt at `<Pi agent directory>/runtime/voice-requests/<UUID>.json`. Receipts are written atomically with private permissions. Each records `version: 1`, `requestId`, `action`, `provider: "codex"`, `sessionId`, `terminalId`, `status`, `running`, `urls` and `browserAttached`, plus `error` on failure. `terminalId` is null outside Herdr. `status` is `running`, `stopped` or `error`. `browserAttached` means a browser audio socket is open, not that the voice provider is connected. Use a fresh UUID for each request, wait for its receipt and remove it after reading. Without a UUID, results appear in Pi.

Use `/codex voice stop` to stop voice. The remote server stops when its owning Pi session changes.

</details>

<a name="models-and-providers"></a>

<details>
<summary><strong>Models and providers</strong></summary>

PCC supports GPT-6 Astra, Sol and Luna, plus GPT-6.1 Sol and Terra, with Responses Lite and live reasoning adjustments on Codex transport. Available context sizes and reasoning levels depend on the selected model. Cost estimates use [published API rates](https://developers.openai.com/api/docs/pricing).

Default scope covers Codex-like GPT routes and Responses providers listed under **Additional providers**. Switching to an unrelated model restores Pi's ordinary tools.

Codex Live voice, dictation, usage and image descriptions can use the Codex login while another provider's model is active. Realtime voice models use the API provider selected in voice settings instead. The separate web and image-generation extensions also use their configured access independently.

</details>

<a name="troubleshooting"></a>

<details>
<summary><strong>Troubleshooting</strong></summary>

- **No voice device:** check the input and output devices under Voice, then restart the call.
- **Browser microphone blocked:** use the HTTPS address and accept its certificate. Browsers block microphones on plain LAN HTTP.
- **Runtime download failed:** check npm, registry or proxy access, then retry. Downloaded runtimes are cached.
- **TS cannot start:** check its platform requirements above and that npm installs optional dependencies.
- **Bundled helper cannot run:** build it on the target machine, set `tools.customRustBinariesDir`, then `/reload`. Do not replace system glibc.
- **Configured provider fails:** the endpoint must support the selected API and features, including Responses Lite or native compaction when enabled.

For source development, build and load the package explicitly from the repository root:

```bash
bun install
bun run --cwd packages/pi-codex-conversion build
pi --no-extensions --no-skills -e ./packages/pi-codex-conversion
```

See [`CHANGELOG.local.md`](./CHANGELOG.local.md) for local changes, [`CHANGELOG.md`](./CHANGELOG.md) for upstream releases, [`UPSTREAM_SYNC.md`](./UPSTREAM_SYNC.md) for synchronization notes or [report an issue](https://github.com/IgorWarzocha/howaboua-pi-stuff/issues). Session startup does not poll npm for updates.

</details>

<a name="extension-apis"></a>

<details>
<summary><strong>Building an integration</strong></summary>

Normal Pi tools work with PCC without additional registration. The [Code Mode example](./examples/code-mode-extension) shows custom tool integration. PCC exposes `code-mode`, `code-mode-hooks`, `code-mode-preflight`, `prompt-mode`, `developer-messages`, `compaction`, `agent-relationship`, `apply-patch-display`, `realtime-voice` and `host-settings` entry points. Shared notes and context are owned by [Notes Compaction](../pi-notes-compaction/README.md).

The `host-settings` entry point exports `hostSettings` for reading or patching global voice settings without starting Pi or voice. Supply the host's absolute agent directory and available `{ provider, modelId }` catalog. For writes, pass a `patch` and the `identity` returned by the latest read.

To expose a tool directly to Realtime voice models, use `registerGippityVoiceTool` from `@howaboua/pi-codex-conversion/realtime-voice` during extension loading. Calls snapshot the registered tools at startup. Ordinary Pi tools are not automatically exposed to the voice model. Standalone GipPity exports the same API from `@howaboua/pi-gippity-control`.

</details>

## License

MIT. Bundled and vendored third-party components retain their own licences and notices.
