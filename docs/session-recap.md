# Session Recap 扩展计划

## 目标

为 Pi 增加一个轻量的 `session-recap` 扩展：用户离开一段时间后，用当前会话的模型生成一段简短的“回到任务”摘要，说明更大的目标、已完成的进展、仍然存在的阻塞/未验证事项，以及（仅在有明确依据时）下一步。

参考实现为 OpenAI Codex 的自动 recap：`tmp/codex`（浅克隆，固定提交见包内 `UPSTREAM.md`）。保留其核心语义，但按 Pi 的扩展 API 和本仓库的包规范重写，不移植 Codex 的 TUI/线程架构。

## 已确认的决定

1. **触发方式**：手动 `/recap` + 空闲自动模式。自动模式默认开启，可在配置中关闭；后台请求会产生模型用量。
2. **代码位置**：新增仓库内包 `packages/pi-session-recap`，不是单文件脚本。
3. **展示方式**：只做临时展示，不写入会话 transcript，不注册持久 entry/renderer。
4. **模型**：默认使用当前会话模型，同时支持可选的 `recapModel` 覆盖；模型无法关闭 thinking 时接受其最低可用级别。本次本地安装选择 `opencode-go/deepseek-v4.1-flash`，不改变包默认值或主 agent 模型。
5. **历史选择**：采用 Codex 的窗口和裁剪方式，但每次用户提交独立开启 exchange，不合并相邻提交。
6. **输出契约**：保留 `summary` + 可空的 `next_action`（UI 上为 `Next:`）。
7. **自动触发**：agent settled 后空闲 30 分钟触发的计时器；任何用户输入或新 turn 会取消。
8. **最终展示**：Editor 上方的临时 widget；生成期间在 footer 显示 `drafting recap...` 状态。
9. **配置与命名**：配置放在 `~/.pi/agent/session-recap.json`；包名 `pi-session-recap`（无 scope）；`recapModel` 使用 `"provider/model"` 字符串。
10. **运行模式**：自动与手动都只在 TUI 提供。命令注册是全局的，但 handler 在非 TUI 模式直接返回，不生成 recap。
11. **空闲重置**：任意终端按键都会重置 30 分钟计时；鼠标滚轮事件不计入。
12. **Widget 生命周期**：保留到下一次提交消息/命令或新 turn 开始；新的 recap 直接替换旧卡片。
13. **Streaming 时的手动触发**：`/recap` 立即用已完成历史生成，不等待当前 turn。正在流式输出的 assistant 不进入历史；当前已提交的 user 消息在完全没有 assistant 消息时作为 pending request 出现，已有 tool 轮次时整段排除。
14. **失败/中止的 turn**：仍算已完成 exchange；自动模式仍可触发，recap 可以指出当前阻塞或失败。
15. **计数作用域**：`minTurns` 与 `minTurnsBetweenRecaps` 只统计当前 branch；fork、navigateTree、switchSession 后重置并从 branch 重新计算。
16. **Turn 计数单位**：已完成的用户 exchange——一条 user 消息加上其后直到下一条 user 的所有 assistant 文本；工具调用步骤不额外计数。
17. **Widget 清除触发**：监听 Enter 提交键；提交消息、内置/扩展 slash 命令、空 Enter 都会清除。方向键、滚动和编辑中的普通按键不清除。
18. **自动失败重试**：失败后 30 秒重试一次；仍失败则静默放弃。用户输入、新 turn、session 切换或 reload 会取消等待中的重试。
19. **只有 pending user 消息时手动触发**：仍然生成；摘要明确说明目前只有待处理请求、尚无已完成进展。只有完全没有可见 user/assistant 历史时才提示无内容且不调用模型。
20. **已有 recap 生成中的手动触发**：提示“已有 recap 正在生成”，不取消、不排队、不并发。
21. **文案语言**：UI 文案使用 English（`drafting recap...`、`Recap:`、`Next:`、错误提示）；recap 正文不强制语言，沿用 Codex 的“使用用户语言”提示，让模型跟随当前对话。
22. **Exchange 边界**：每次用户提交都开启一个新的 exchange；只有该 exchange 内存在终态 assistant 消息（`stop`、`length`、`error`、`aborted`）时才计入“已完成”；`pending`、`toolUse`、`deferred` 都不算终态。agent 未 settled 时的 steering/排队提交也算新的 exchange，不并入前一个。
23. **冷却更新**：任何成功的 recap（手动或自动）都把冷却位置推进到当前已完成 exchange；自动模式必须再等到 `minTurnsBetweenRecaps` 个新的已完成 exchange，并且距最后一次用户活动空闲 30 分钟，才会再次生成。失败的 recap 不推进冷却。
24. **手动请求取消**：手动 `/recap` 生成中，用户提交新消息/开始新 turn 时取消该请求；普通 slash 命令不取消请求（但 Enter 会清除卡片），session 切换/reload 也会取消。
25. **自动重试等待期**：30 秒等待期间 footer 保持 `drafting recap...`；重试成功或最终失败后清除。手动 `/recap` 会取消等待中的自动重试并立即执行。
26. **Enter 检测**：Pi 不会为内置/扩展 slash 命令触发 `input` 事件，因此用 `ctx.ui.onTerminalInput()` 观察 Enter 提交键来清除卡片；代价是空 Enter 和补全确认也会清除。
27. **空闲计时起点**：`idleSince = max(agent settled 时间, 最后一次非滚轮终端输入时间, 最后一次成功 recap 时间)`；只有 `now - idleSince >= idleMinutes` 才触发。长时间 agent 运行结束后不会因为用户输入早已过期而立刻触发。
28. **自动失败后的退避**：30 秒重试仍失败后，把 idle 计时起点重置到当前时间，并且不自动安排下一次尝试；等下一次用户活动/agent settled 后重新计时。手动失败不退避、不推进冷却。
29. **Streaming 的 in-progress exchange**：手动 `/recap` 遇到最新 user 请求已有 assistant 消息（包括 `toolUse`）但无终态回答时，整段排除，不作为 pending request，也不进入 prompt；若没有其他已完成 exchange 或 pending user，提示 `There is no completed conversation history to recap.` 且不调用模型。

## 参考实现的关键事实

Codex 的相关源码：

- `codex-rs/context-fragments/src/recap_prompt.rs`：提示词与 8,192 token / 32 KiB 上限。
- `codex-rs/tui/src/app/recap.rs`：触发条件、生成、解析、重试。
- `codex-rs/tui/src/app/recap_history.rs`：历史选择与截断。
- `codex-rs/tui/src/history_cell/notices.rs`：加载中与结果展示。

关键常量和行为：

- 至少 3 个已完成 exchange；两次 recap 之间至少 2 个 exchange（Codex 原文用 turn，本扩展按用户 exchange 计数）。
- 空闲 30 分钟后触发自动 recap（Codex HEAD 的 `RECAP_DELAY`）。
- 最多 8 组已回复的 user/assistant exchange，外加一个尚未回复的 user request。
- 合并相邻 user 消息；只保留可见的 user/assistant 文本，忽略 tool、reasoning、其他线程。
- 历史总预算 32 KiB；先丢弃最旧的完整 exchange，再对两端做 excerpt。
- 保留最新的回答和 pending correction；省略处加标记。
- Codex 的 history 标签为 `User`、`Assistant`、`Pending user request`；省略标记为 `[Earlier exchanges omitted]\n\n`，截断标记为 `\n[... excerpted ...]\n`。
- 结构化输出：`summary` 1–700 字符，`next_action` 为 string 或 null、最多 200 字符。
- Codex 的解析器用 `serde_json::from_str::<GeneratedRecap>()` 加 `deny_unknown_fields`；不会剥掉 Markdown 围栏，所以围栏 JSON 会被拒绝。
- 提示词要求 40–60 词、最多 80 词，使用用户语言，保留未解决/未验证 caveat，不把新请求当成已完成。
- Codex 用临时 thread 生成一次结构化 turn；Pi 版本用 `ctx.modelRegistry.streamSimple(...).result()` 直接发一次请求，以便通过公共、provider-neutral 的 `reasoning` 选项选择最低可用 thinking 级别。

## Pi 版本的行为契约

### 入口与模式

- 默认导出扩展工厂，注册 `/recap` 命令。
- `/recap` 只在 TUI 执行；其他模式直接返回，不发起模型请求。`pi.registerCommand` 本身没有模式参数，因此命令仍会在所有模式注册，由 handler 检查 `ctx.mode !== "tui"`。
- `/recap` 在 agent streaming 时也可被接收，并立即用已完成历史生成，不等待当前 turn。
- 手动请求生成中若用户提交新消息/开始新 turn，则 abort 该请求；普通命令不打断它。
- Pi 只在 `message_end` 时把消息写入 session；`message_update` 不持久化。因此 `getBranch()` 不会包含正在流式输出的半个 assistant，当前已提交的 user 消息会作为 pending request 参与历史。
- 如果 branch 中没有任何可见 user/assistant 消息，手动命令提示没有可总结的对话，不发起模型请求。
- 如果最新 user 请求之后完全没有 assistant 消息（即只有 pending user），手动命令仍生成 recap；提示词把该消息标为 pending request，输出说明尚无已完成进展。
- 如果最新 exchange 已有 assistant 消息但尚无终态回答（例如只有 `toolUse` 轮次），整段排除；若没有其他已完成 exchange 或 pending user，提示没有已完成历史，不调用模型。
- 自动模式通过生命周期事件和计时器实现，不依赖不存在的终端焦点事件。

### 历史选择与计数

- 从 `ctx.sessionManager.getBranch()` 读取当前分支。
- 只取当前分支中可见的 user/assistant 消息文本。
- assistant 只取 text parts；忽略 thinking、toolCall、toolResult。
- 以每条 user 消息为 exchange 边界，把其后直到下一条 user 的所有 assistant 文本归入同一个 exchange；与 Codex 不同，不合并相邻提交。
- 每次用户提交都开启新 exchange；agent 尚未 settled 时的新提交也算新 exchange，不并入前一个。
- 只有在最新 user 请求之后完全没有 assistant 消息时，才把它作为 pending request 保留；正在流式输出的 assistant 不属于已完成历史。
- 已有 assistant 消息但 exchange 未终态时，整段排除，不把未完成工作当成已完成进展。
- 最多 8 个已回复 exchange，外加一个 pending request；prompt + history 总预算 32 KiB，history 上限为 32 KiB 减去 prompt 字节数。
- 先丢弃最旧的完整 exchange，再对两端做 excerpt；截断必须落在 UTF-8 字符边界，并加入省略标记。
- excerpt 的逐字符遍历只覆盖实际保留的头尾，不逐字符扫描被丢弃的大段正文；字节长度计算仍可遍历原文。
- 已完成 exchange 的计数只认有至少一条终态 assistant 消息（`stop`、`length`、`error`、`aborted`）的 user 请求；`pending`、`toolUse`、`deferred` 都不算终态。纯工具调用步骤不单独计数。
- 门控计数基于整个当前 branch，不受 8 组/32 KiB 历史裁剪影响。
- 计数是 branch 作用域：在 `session_tree`、fork、navigateTree、switchSession 后重置，并从当前 branch 重新计算；上次 recap 的位置是内存状态，切换时重置，不持久化。

### 生成与解析

- 默认模型为 `ctx.model`；若配置了 `recapModel`，按第一个 `/` 解析成 provider/model id，并在 `ctx.modelRegistry` 中查找。
- `recapModel` 无效或不可用时回退当前模型，并给出一次警告；不回退到硬编码模型。
- 用 `ctx.modelRegistry.streamSimple(model, { systemPrompt, messages }, { signal, reasoning }).result()` 发一次请求；支持 off 时省略 reasoning，否则显式选最低可用级别。使用公开 API，不改变主 agent 的 thinking 设置。
- 请求通过公开 `sessionId` 选项传入 `${ctx.sessionManager.getSessionId()}:recap`，满足 provider 的会话路由要求，并与主 agent 的请求通道分开；不创建或写入 Pi 会话。
- 不依赖 provider 的 JSON schema / responseFormat；提示词要求纯 JSON，扩展侧解析并校验。
- 响应必须是 JSON object；拒绝数组、null、Markdown 围栏、JSON 之外的尾随文本和额外字段。
- `summary` 必须是非空 string；`next_action` 必须是 string、null 或缺失（缺失视为 null）。两者 `trim()` 后按 Unicode code point 计数，不用 JS 的 UTF-16 `.length`，以匹配 Codex 对中文/emoji 的字符计数。
- 拒绝空 summary、超过 700 code point 的 summary、超过 200 code point 的 next_action；空白 next_action 归一为 null。
- 非法输出给出可读错误，不把半截 JSON 当 recap；手动失败统一显示 `Could not generate a recap. Please try again.`。
- 手动失败用 `ctx.ui.notify(..., "error")`；自动失败不向用户弹错。
- 手动触发时若已有 recap 在生成，直接提示 `A recap is already being generated.`，不发起第二个请求。
- 完全没有可见 user/assistant 历史时提示 `There is no conversation history to recap.`；只有 in-progress exchange、没有已完成或 pending 历史时提示 `There is no completed conversation history to recap.`，两者都不调用模型。
- 关闭 recap 生成时 abort 当前请求；不要影响主 agent 的 streaming。
- 任何成功生成（手动或自动）都记录当前已完成 exchange 数作为冷却位置；失败不记录。

### 展示

- 生成中：`ctx.ui.setStatus("session-recap", theme.style("drafting recap...", { fg: "dim", italic: true }))`，模仿 Pi 原生 `Thinking...` 的低干扰提示；完成或失败后清除。
- 完成后：Editor 上方的临时 widget，展示 `Recap: ...` 和可选的 `Next: ...`；summary 使用 dim/italic，`Next:` 可使用粗体标签。
- `setWidget()` 的 `MAX_WIDGET_LINES` 只限制传入字符串数组的长度，不限制 `Text` 换行后的实际渲染高度；卡片最多显示 10 个渲染行，summary 超出时按可见宽度截断并追加 `…`，`Next:` 行始终保留，优先保留 summary 开头，避免挤占屏幕。
- 通过 `ctx.ui.onTerminalInput()` 监听原始终端输入。普通消息提交用 `input` 事件清卡；slash/`!` 命令不触发 `input`，因此 Enter 到达时用 `ctx.ui.getEditorText()` 判断编辑器内容：空文本或以 `/`、`!` 开头才清卡。这样可避免普通文本输入/IME 组合确认误清卡，同时覆盖命令提交。
- 方向键、滚动和编辑中的普通按键不清除。`onTerminalInput()` 也会收到鼠标序列；滚轮序列（SGR 按键 64–67、旧式鼠标滚轮）不重置空闲计时，也不清卡。
- 普通命令只清卡片，不取消正在生成的手动请求；session 切换/reload 和新的用户 turn 会取消。
- 生成期间旧卡片保留；成功后直接替换。失败/取消时保留旧卡片，若没有旧卡片则保持空白。
- 扩展卸载/reload 时取消 `onTerminalInput` 监听、计时器和在途请求。
- 不追加 custom entry，因此 recap 不进入模型上下文，也不会在会话恢复后重现。

### 自动模式

- 配置默认开启，可用 `auto: false` 关闭。
- 候选条件：当前为交互 TUI、agent 已 settled、当前 branch 的已完成 user exchange 数达到 `minTurns`、距上次成功 recap（手动或自动）的已完成 exchange 数达到 `minTurnsBetweenRecaps`、`now - idleSince >= idleMinutes`。`idleSince` 取 `max(agent settled 时间, 最后一次非滚轮终端输入时间, 最后一次成功 recap 时间)`。
- 最后一次 exchange 以 error/aborted 结束仍可触发；无需等待新的成功 turn。
- 用户输入、agent start、session 切换、reload 时取消计时器。
- 任意终端按键（鼠标滚轮除外）重置空闲计时；计时从最后一次按键重新开始。
- 任何 recap 生成中都不发起新的自动请求；已有手动请求时自动计时器直接跳过。手动 `/recap` 会取消等待中的自动重试并立即执行。
- 自动请求生成中，任意非滚轮终端按键或新 turn 都取消请求（用户已回到终端）；手动请求只在提交新消息/新 turn 时取消，普通按键不取消。
- 失败后 30 秒重试一次；仍失败则静默放弃，不自动安排下一次尝试。等待重试期间发生用户输入、新 turn、session 切换或 reload 时取消重试。
- 30 秒等待期间 footer 保持 `drafting recap...`；重试成功或最终失败后清除。
- 成功生成后记录冷却位置并重置空闲计时；即使没有新的 exchange，30 分钟空闲到期也不会再次触发。
- 最终失败后把 `idleSince` 重置到当前时间；等下一次用户活动/agent settled 后重新计时。
- branch 切换时重置内存中的上次成功 recap 位置；切回旧 branch 也不恢复旧的冷却位置，按当前 branch 重新计算。
- `session_tree` 回调期间 Pi 尚未释放导航的 busy 状态；新 branch 仍须安排空闲计时，到期时再检查公开 `isIdle()`，不能把回调中的瞬时 busy 固化为未 settled。
- 自动模式不把错误弹给用户。

### 配置

- 路径：`~/.pi/agent/session-recap.json`，沿用 `pi-ask` 的 `getAgentDir()` 约定。
- 默认值：`auto: true`、`idleMinutes: 30`、`minTurns: 3`、`minTurnsBetweenRecaps: 2`、`recapModel: null`。`minTurnsBetweenRecaps` 指距上次成功 recap 的新已完成 exchange 数。
- 配置文件不存在时写入默认配置；读取或解析失败时使用内存默认值，不阻止扩展加载。
- 多个 Pi 同时首次启动时，以独占创建保留先写入的默认文件；创建文件时的 `EEXIST` 不误报警，目录创建和其他写入失败仍警告。
- 非法值回退默认并给出一次警告；`recapModel` 必须是 `provider/model` 字符串或 null。
- 配置在扩展加载时读取；修改后需要 reload 或新会话生效。

## 重要权衡

- **临时展示**：代码少、无 transcript 污染；缺点是错过就没了，会话恢复后不可见。
- **TUI-only**：UI 行为一致、实现简单；RPC/JSON/print 用户无法使用 `/recap`。README 必须明确。
- **新包**：符合仓库的检查/交付边界；独立安装，不加入现有可选整合包，包扫描流程自动发现它。
- **当前模型 + optional recapModel**：无需额外配置；代价是 recap 会计入当前模型的成本和 thinking 行为。`opencode-go/deepseek-v4.1-flash` 的 `thinkingLevelMap.off` 为 null，Pi 会把 off 提升到 low，因此无法通过正常抽象完全关闭 thinking；接受最低可用级别，或用 `recapModel` 换模型。
- **结构化 JSON**：跨 provider 可移植；代价是偶发解析失败，需要严格校验和错误提示。
- **32 KiB / 8 exchanges**：控制成本和延迟；代价是很长的会话只保留最近上下文，早期目标可能丢失。
- **exchange 计数**：不会被工具调用步骤放大；代价是需要按 user 边界重组历史，而不是直接使用 `turn_end`。
- **pending-only 手动 recap**：多一次模型调用；代价是没有已完成进展时输出可能很短，但比拒绝更有用。
- **双门控**：自动触发同时要求“2 个新 exchange”和“30 分钟空闲”；两者独立，避免用户刚 recap 完又收到重复摘要，也避免用户仍在操作时被打扰。
- **空闲从 settled 起算**：长时间 agent 运行结束后仍会等满 30 分钟才自动 recap，避免把“用户在等 agent”误判为“用户离开”。
- **手动请求可取消**：新消息/新 turn 会取消手动 recap，避免旧摘要插入新 turn；代价是用户可能需要在稍后重新执行 `/recap`。
- **Enter 清卡**：用 `input` 事件处理普通消息，用原始 Enter + 编辑器内容处理 slash/`!` 命令，能覆盖 Pi 不触发 `input` 事件的情况；代价是空 Enter 和 slash 补全确认也会清卡。
- **未完成 exchange**：严格的“只总结已完成 exchange”会漏掉当前 tool 轮次的进展；选择排除整段，避免把未完成工作写成进展。
- **卡片高度上限**：最多 10 个渲染行，保证 recap 不挤占屏幕；代价是极窄终端下可能截断 summary 尾部的 caveat。

## 实现边界

- `packages/pi-session-recap/index.ts`：Pi 接线——注册命令、生命周期、TUI 输入监听、配置和 controller。
- `packages/pi-session-recap/src/controller.ts`：手动/自动状态机、空闲计时、在途取消、冷却位置、UI 调用；clock/scheduler/generator/UI 通过参数注入，便于假时钟测试。
- `packages/pi-session-recap/src/terminal-input.ts`：原始输入分类——Enter 提交、滚轮序列、普通按键。
- `packages/pi-session-recap/src/config.ts`：读取、校验和默认配置。
- `packages/pi-session-recap/src/history.ts`：从 branch 提取 exchange、裁剪到 8 组/32 KiB。
- `packages/pi-session-recap/src/prompt.ts`：Codex prompt 的 Pi 移植、JSON 解析与校验。
- `packages/pi-session-recap/src/generate.ts`：模型选择、`streamSimple().result()` 调用、abort 和错误处理。
- 历史大文本裁剪保留用户要求的永久回归测试；其余历史、解析和状态机通过隔离一次性探针验证。
- `packages/pi-session-recap/README.md`、`LICENSE`、`NOTICE`、`package.json`、`tsconfig.json`。
- 包版本从 `0.1.0` 开始；`package.json` 用 TS entry（`main`/`exports`/`pi.extensions` 指向 `index.ts`），无 build script。

## 测试策略

- 历史选择探针：相邻 user 各自开启 exchange（未回复的旧请求不冒充已完成历史）、忽略 tool/reasoning、8 组上限、pending request、32 KiB 截断、UTF-8 边界。
- `packages/pi-session-recap/test/history.test.ts` 通过 `buildHistory()` 验证大文本头尾保留、UTF-8 完整性和字节预算；预热后测 CPU 用时，以宽松上限捕获逐字符扫描整段正文的性能回归，不依赖墙钟调度或私有实现。
- 解析探针：合法 JSON、null/缺失 next_action、空/超长 summary、超长 next_action、额外字段、数组/null 根值、Markdown 围栏（拒绝）、尾随文本；中文/emoji 按 code point 计数。
- 触发状态机：min turns、turns between、idle 从 settled 起算、输入取消、生成中取消、自动失败 30 秒重试一次、最终失败不自动重排、branch 切换重置。
- 命令行为：非 TUI 不调用模型；无历史不调用；只有 pending user 时调用；只有 in-progress exchange 时整段排除、提示没有已完成历史且不调用模型；已有 recap 生成中时第二次调用被拒绝。
- 终端输入分类：Enter 清卡条件（空文本、`/`、`!`）、普通文本不清卡、SGR/旧式滚轮不重置空闲、普通按键重置空闲。
- 自动检查使用 fake ModelRegistry / fake clock，在隔离环境离线运行；除用户要求的大文本裁剪回归测试外，历史、解析、计费触发和取消使用一次性探针。导航后自动触发和并发创建配置通过一次性探针验证；现有 released Pi 集成验收包含本包入口、命令与清理。
- 用户已授权真实模型验收：仅 `openai-codex/gpt-6-luna` 与 `opencode-go/deepseek-v4.1-flash`，通过 Herdr 中隔离 Pi TUI 的连续工具回合和 recap 验证。只在 sandbox 使用授权登录，不输出凭据，不改真实 Pi 设置。
- 不把开发代码安装进真实 Pi 设置。

## 许可与归属

- Codex 使用 Apache-2.0（`tmp/codex/LICENSE`，Copyright 2025 OpenAI），并有 `tmp/codex/NOTICE`。
- 本包原创代码使用 MIT；从 Codex 移植的 prompt 文本/算法在 `NOTICE` 中保留 OpenAI 版权与 Apache-2.0 许可，并在对应源码文件头部注明来源与修改。
- README 说明“参考/部分移植自 OpenAI Codex 的 recap 实现”，不暗示 OpenAI 背书。
- 若最终 prompt 经过大幅重写而非逐字复制，仍保留来源说明；许可文件不因重写而删除。

## 验收状态

- 包、使用文档、workspace 登记与许可归属已完成；自动 recap 默认开启。
- `npm run verify` 通过：构建、静态检查、两项永久历史裁剪回归测试和现有测试均通过。
- 隔离离线探针通过，覆盖历史/UTF-8 预算、严格 JSON 解析、触发门控、重试/取消、输入分类、10 行渲染上限和 released Pi bundled loader。
- 导航修复通过 released Pi 1.4.0 的公开 `navigateTree(..., { summarize: false })` 流程及假时钟验证；配置修复通过 128 轮真实文件系统并发首次加载验证，保留独占创建和真正错误的警告。
- `openai-codex/gpt-6-luna` 与 `opencode-go/deepseek-v4.1-flash` 均在 Herdr 的隔离 Pi 1.4.0 TUI 中通过连续三个真实工具回合后的自动及手动 recap；摘要保留未安装、未验证事项，不凭空添加下一步。
- 真实模型验收仅把 sandbox 的空闲时间缩短为 9 秒，未修改真实 Pi 设置；产品默认仍为 30 分钟。
- 导航、裁剪和配置修复仅重跑了离线验证，未重复真实模型验收。

## 开放问题

当前没有需要用户拍板的问题。不同终端/IME 的所有输入变体与所有主题未逐一实机验收；已有输入分类和窄屏渲染探针不替代这些平台验收。

## 下一步

源码实施与模型验收已完成，用户已授权提交与本地安装。按 [开发与安装流程](development.md#本地安装工作区) 准备不含 `.git` 的完整安装工作区；本包与 pi-ui、可选整合包共用同一工作区，分别登记，不另复制仓库。更新前核对并保留原目录的本地改动，验证设置备份可恢复后使用原生 `pi install` 登记本包。保持 `recapModel: "opencode-go/deepseek-v4.1-flash"`、默认自动模式与其他扩展配置；安装检查不额外请求真实模型。
