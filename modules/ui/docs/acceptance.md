# Stage-one UI acceptance

**Stage-one UI accepted by the user.** The requested repository rename and footer-source-label removal are complete. This record covers only `modules/ui`; whole-package validation is covered by the root integration suites and release qualification. No formal global deployment was made by these tests.

## Run the isolated integration suite

From `/home/thelya/Work/Scripts/pi-Serraly`:

```sh
node --import tsx --test modules/ui/test/runtime-integration.test.ts
```

The recursive test runner discovers all test files. For the whole workspace:

```sh
npm run verify
```

To check only the runtime integration file:

```sh
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck \
  --target ES2022 --module NodeNext --moduleResolution NodeNext --types node \
  modules/ui/test/runtime-integration.test.ts
```

## Inspect synthetic UI fixtures

Run these in a real terminal:

```sh
node scripts/preview.mjs regular
node scripts/preview.mjs fullscreen
```

The preview starts a real Pi 0.99.2 bundled CLI with a scripted provider, a synthetic built-in `read` tool call, thinking, Markdown, a table, code, and Unicode. Try:

- `/ccstyle status`
- `/ccstyle on`, `/ccstyle compact`, `/ccstyle off`
- `/ccstyle panel` (Escape to close)
- `/context` (Escape to close)
- `/quit`

Preview changes live only in the temporary agent directory. The old global extensions never load: the process gets an isolated HOME/agent directory, disables discovery with `--no-extensions`, and loads only the explicit guard, compiled UI, and diagnostic/provider fixture extensions.

### Optional rich manual profile

For built-in file/diff rows and richer Markdown, run:

```sh
node scripts/preview.mjs regular rich
node scripts/preview.mjs fullscreen rich
```

The default commands above remain read-only and keep the existing integration and
six-capture fixture unchanged. The optional `rich` profile selects only Pi's real
built-in `read`, `write`, and `edit` tools through the native CLI. Its local,
offline scripted provider reads `rich-seed.txt`, writes a **new** `rich-preview.ts`,
then edits known content in that file. Both files live under the printed temporary
sandbox's `cwd`; `/quit` removes the sandbox. HOME, config, cache, and agent data
remain isolated, and the network-denial preload stays active. No live provider,
MCP connection, or real auth/session data is used.

Use Ctrl+O to expand/collapse the three tool rows and inspect the actual file
card, before/after diff, long Unicode lines, and retained content. Compare
`/ccstyle on`, `/ccstyle compact`, and `/ccstyle off`. The final reply includes all
five admonitions, Chinese/fullwidth URL boundaries, literal `www` paths containing
`a_b_c` and `$x$`, authoritative quoted/list reference definitions, a standard
`mermaid` fence, and an unknown-language fence. Open native `/settings` to compare
Mermaid `off`, `final`, and `streaming`; these settings also stay temporary.

Rich previews enable native OSC8 hyperlinks explicitly (`PI_HYPERLINKS=1`) using
reserved `example.invalid` targets. Inspect link destinations without opening
them; the local CLI's network guard does not control an external browser. This
profile supports manual inspection, not an additional capture matrix or completed
visual acceptance.

### Automated default captures

Generate automated POSIX PTY captures at 40/80/120 columns in both terminal modes:

```sh
node scripts/capture.mjs /tmp/pi-ui-stage-one-captures
less -R /tmp/pi-ui-stage-one-captures/regular-80.ansi
```

The output contains six raw ANSI streams and six synthetic diagnostic JSON files. Captures exercise the initial scripted tool loop, `/ccstyle status`, and `/quit`. Inspect panel/context interactions with the interactive preview. These are terminal streams, not screenshot goldens or completed visual acceptance.

## What the tests validate

| Boundary | Evidence |
| --- | --- |
| Factory | Pi's loader loads the compiled ESM; zero UI timers/prototype patches during loading; no tool registrations, flags, or shortcuts; exactly `ccstyle` and `context`; `ccstyle` completions are `on`, `compact`, `off`, `status`, `panel`; one registered host handler per UI event. |
| Help/version | Actual `package.json` CLI bin is `dist/bundle/cli.js`; version is exactly `0.99.2`; `--help` loads factories but starts no sessions or provider calls. |
| Print/JSON/RPC | A deterministic two-turn agent loop calls the host's built-in read tool and returns a final assistant response. UI-owned timers stay at zero, ToolExecutionComponent/AssistantMessageComponent/Container methods remain native, and no header/footer/bridge is installed. RPC's `hasUI=true` does not activate TUI features. |
| Commands | `/ccstyle status` executes without a model call. RPC reports exactly the two UI commands and returns `handled` for extension commands. `/context` reports an estimated fallback; an SDK command context with empty sources reports Unknown, then Estimated after a synthetic message. |
| SDK lifecycle | Real `createAgentSession`, DefaultResourceLoader, ExtensionRunner, SettingsManager.inMemory, AuthStorage.inMemory, and SessionManager.inMemory. Three TUI start/shutdown cycles plus active routed restart replace one bridge/header/footer; only one UI scheduler timer is live; shutdown restores prototypes and removes mounted UI/timers. A `tui` context without UI remains inactive. All style modes and both panel/context overlay factories execute. |
| Actual reload | `host-reload.test.ts` calls real `session.reload()` for defaultTools addition/removal/manual disable/re-addition/explicit selection and two TUI transcript generations. Native rows rebuild between old shutdown and new session start. |
| Native previews | Real Pi 0.99.2 bash/codemode/MCP definitions exercise VisualLinePreview/Container behavior, visual widths, protected renderers and retained output/truncation notices. Native assertion classes come from coding-agent's dependency closure. No MCP client or tool execution occurs. |
| Markdown destinations | 262 real-host render fixtures and 270 transformer tests check actual OSC8 destinations, literal URL text, visible punctuation, code/target preservation and complete reference definitions in nested containers/across code. Validated original-source ranges own protection; collection cannot expand them into later prose. Native lazy list continuations, non-interrupting inline HTML and actual HTML-block termination have regressions. |
| Failure/compaction boundaries | Synthetic missing/read-only method acquisition, foreign throwing Thinking wrappers and invalidated context getters exercise unconditional cleanup. A delayed downstream compaction handler proves the refresh follows mounted-tree replacement, rather than a timer turn. |
| Bundled host identity | Before/after fixtures use the CLI's embedded-module extension loader. A live interactive-mode TUI is an instance of its imported TuiMainScreen/TuiAltScreen. A host-created transcript tool row is an instance of the imported ToolExecutionComponent; its actual prototype equals the shared patch symbol's prototype, its methods equal the installed methods, and it uses the UI renderer. |
| Terminal modes/widths | Eight actual CLI PTYs: six default regular/fullscreen × 40/80/120, plus rich regular/fullscreen at 80, all 44 rows. Diagnostics verify terminal mode, shared native tool/TUI identity, and tool-row bounds at 40/80/120. The suite checks alternate screens, notifications and cleanup; rich also verifies three real temporary file/diff rows and native OSC8. |
| Isolation | Default cwd empty; rich cwd contains exactly its seed and new/edited preview file. No persisted sessions or staged node_modules; allowlisted child environment, isolated HOME/agent/model cache, and a preload rejects accidental fetch/socket/HTTP/TLS/DNS access. |

The grouping compatibility slot can retain an inactive reload tombstone. The diagnostic verifies native Container methods, an inactive grouping record, empty groups, and no grouping animation timer rather than demanding deletion of that record.

## Runtime staging and prerequisites

- Node.js ≥22.19; validation used Node.js 24.12.0.
- Workspace-pinned esbuild/tsx/TypeScript provide build/test tooling only.
- The global Pi 0.99.2 package supplies the actual CLI. By default its path is derived from the active Node installation's `../lib/node_modules/@earendil-works/pi-coding-agent`.
- To select another installed **0.99.2** host outside the development tree:

  ```sh
  PI_UI_HOST_PACKAGE=/absolute/path/to/pi-coding-agent \
    node --import tsx --test modules/ui/test/runtime-integration.test.ts
  ```

- Tests locally compile current UI source to a temporary `pi-ui/index.js` ESM bundle outside the workspace. Only this current compiled stage is loaded at runtime. Host packages stay external; the build metafile rejects embedded Pi/TypeBox/removed Mermaid dependencies.
- The root test runner and runtime children use allowlisted environments with temporary HOME/config/cache/agent directories. Only an intentional `PI_UI_HOST_PACKAGE` override is forwarded. CLI subprocesses use `--offline --no-extensions --no-session`, explicit fixture/UI extensions, and disabled skill/template/theme/context discovery.
- The fixture provider uses a literal synthetic key solely to satisfy Pi's provider configuration contract. It never connects to an endpoint or persists a credential.
- Pi 0.99.2 defines AuthStorage.inMemory in `dist/core/auth-storage` but does not re-export AuthStorage from the SDK root. The test worker makes that pinned test-only import; production UI imports are unchanged.
- PTY capture uses `/usr/bin/python3` and its standard POSIX `pty`, `termios`, and `fcntl` modules. Only the eight optional PTY tests—six default and two rich—skip if that dependency is missing, with the reason in test output. Missing/wrong Pi hosts, build errors, and runtime failures fail the suite.
- Normal runs and test deadlines clean their temporary sandboxes. Capture output is retained only in the explicitly chosen capture directory.

## Validation record and acceptance limits

The runtime integration suite passes **14/14, zero skips**, including eight real
PTYs. The default capture command retains its six-mode/width matrix; rich captures
are additional 80-column evidence, not a replacement for that matrix.

Final post-fix `npm run verify` passed typecheck, **801/801 tests**, zero failures
or skips, and build. The entry passes `node --check`; the build carries all
preserved license records and externalizes the three host runtime imports.
The rename/footer revision passed the same **801/801** suite; log:
`/tmp/pi-serraly-ui-acceptance-verify.log`. Footer occupancy remains, while source
labels are available only in `/context`.
Raw ANSI/diagnostic JSON are in `/tmp/pi-ui-stage-one-captures`: six default
captures plus `rich-regular-80` and `rich-fullscreen-80`, captured before the final
footer-label removal.

Final scoped source reviews closed the reported Markdown container, validated-range,
lazy-list, inline-HTML and HTML-termination findings with no issues found in the
revised scopes. Reviewers inspected source/fixtures; the test and capture results
above are separate execution evidence.

Automated evidence covers factory, isolation, lifecycle, protocol, class identity, and synthetic render bounds. User acceptance covers the actual appearance and interaction in the target terminal, including panels, context previews, mouse/focus behavior, and resize transitions. No real auth/session files or live provider requests are used in either path.

### User visual checklist

The checklist below remains a reference. The user's acceptance covers the
inspected temporary UI and the two requested final changes; not every item was
separately signed off.

- [ ] Welcome panel and footer retain the expected layout, model/cwd, runtime and status segments.
- [ ] Compare on/compact/off; Thinking preview remains interactive in off.
- [ ] Open all five panel pages; confirm twelve settings and keyboard/focus behavior.
- [ ] Inspect `/context` labels, six categories and text preview; Escape closes the active overlay.
- [ ] Fullscreen hover/expand/collapse, ordinary text selection and links behave correctly.
- [ ] Resize between narrow/wide layouts and switch light/dark themes without stale content.
- [ ] Confirm file/diff cards, long-line wrapping and retained-data expansion from their synthetic fixtures.
- [ ] Native Mermaid settings/fallbacks and bare-URL destinations meet expectations.

At CJK punctuation boundaries, `www` paths containing Markdown-active characters
use native inline-code labels so text such as `$x$` stays literal. Include that
documented style difference in the visual check.

The automated six-PTY capture covers a read/on-mode conversation. It does not
complete this manual checklist or replace the user's stage-one acceptance.

## Pi 0.99.2 references used

The installed package under `/home/thelya/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent` is the versioned reference:

- `docs/sdk.md`, `cli.md`, `cli-integration.md`, `sessions.md`, `session-format.md`, `message-types.md`
- `docs/rpc.md`, `rpc-commands.md`, `rpc-extension-ui.md`, `json.md`
- `docs/extensions.md`, `tui.md`, `custom-provider.md`, `configuration.md`, `settings.md`, `environment-variables.md`, `security.md`, `how-pi-works.md`, `compaction.md`
- SDK examples 01, 02, 05, 06, 09, 10, 11, 12, 13; RPC client/UI examples; widget/footer/RPC demo and custom-provider GitLab Duo examples
- Installed SDK/session/model/auth/resource-loader/extension-runner declarations, extension loader/virtual-module implementation, and bundled CLI entrypoints
