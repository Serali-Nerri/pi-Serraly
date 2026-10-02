> Historical source-fork plan and verification record, preserved from `bg` HEAD
> `86c52d3b5d9f9ab92b843868293495d17ec5d878`. Paths, install commands and
> Pi 0.99.1 results below describe that earlier fork, not current workspace
> instructions. Use this module's README/TESTING and the repository root docs.

# pi-background-tasks 纯后台任务 fork 计划

## Context（背景与目标）

将 `pi-background-tasks` fork 为只管理后台 shell 命令的本地 Pi 扩展，减少不需要的功能、模型上下文说明和维护负担。用户已确认：

- 不保留 `promptSnippet`、`promptGuidelines`；必要使用说明仅放工具及参数的 `description`。
- 删除 `before_agent_start` 的 shell 说明注入，但保留实际 shell 选择和执行逻辑。
- 删除委托代理、全部 Fusion、attested Pi、Anthropic attribution。
- **第一轮就删除 `isAgent` / `--agent` 和全部 Pi 使用量遥测**，不为兼容而保留它们。
- 只在本地保存本计划，批准实施前不导入源码、不安装依赖、不修改配置或执行测试。

基线：npm `pi-background-tasks@2.6.8`，上游 commit `471f1dcae7ff13d8f989e4c056bdff1e6b01f1ef`。此前已核对 npm 的源码、入口、dist 与该 commit 一致。

上游：<https://github.com/ismailsaleekh/pi-background-tasks>。调研副本在 `/tmp/pi-background-tasks-research.M7RcmH/upstream`，仅供参考，不依赖临时目录长期存在。

实施目录：`/home/thelya/Work/Scripts/bg`。主要验证宿主：Pi `0.99.1`；上游测试依赖锁定的是 `0.84.0`，不能直接复制其兼容声明。

执行状态：用户已明确批准“执行吧”；以下实施已在本地完成，包名确定为 `pi-background-shell@0.1.0`。平台验证范围和最终结果单独记录，不将跳过测试算作通过。

## 1. 最终保留范围

| 公开接口 | 保留功能 |
| --- | --- |
| `bg_run` | 启动命名 shell 任务，立即返回任务 ID、PID、输出路径；可设置描述、超时、通知、唤醒和 reload 存活 |
| `bg_status` | 查询单个或近期任务，支持唯一 ID 前缀 |
| `bg_logs` | 按需读取有上限的 head/tail，提供截断提示和完整输出路径 |
| `bg_kill` | 停止运行任务及其进程树，未知或已结束任务报错 |
| 命令 | `/bg`、`/jobs`、`/logs`、`/kill`、`/tasks`、`/bg-tasks`、`/bg-clear` |
| UI | footer、列表、详情、日志跟随/滚动、停止、确认后停止全部、重新运行、输出路径、完成提示确认 |
| 快捷键 | dock 的 `shift+down` / `ctrl+alt+b` / `off` 配置，以及清除完成提示的快捷键 |
| 扩展间调用 | capabilities、run、status、logs、kill，以及终态事件；使用 fork 自己的版本化协议 |

保留现有任务状态 `running/completed/failed/killed`、元数据原子写入、输出限额、启动/关停竞态保护、POSIX 进程组终止、Windows `taskkill /T`、同进程 reload 交接。

保留默认 20 MiB 任务输出上限、50 KiB 模型日志读取上限与近期记录淘汰规则。元数据使用 fsync/rename；普通输出只关闭并等待写完，不承诺断电不丢尾部内容，磁盘日志不随内存记录淘汰而删除。

默认值不变：`bg_run` 通知和自动唤醒均开启；`/bg` 通知开启但不自动唤醒；`surviveReload` 默认关闭。通知关闭时，唤醒开关不产生作用。

新 `bg_run` 参数：必填 `name`、`command`；可选 `description`、`timeoutSeconds`、`notifyOnCompletion`、`triggerOnCompletion`、`surviveReload`。不再要求模型判断命令是不是 agent。

所有命令一视同仁：用户自行写的 `pi ...` 也只是普通 shell 命令，不拦截、不包装、不解析 Pi JSON、不选择模型或提供鉴权。reload 存活按普通 shell 的执行所有权判断，不再检查 `isAgent`，也不通过扫描命令文本重新引入该分类。

### 明确不做

- 不接管内置 `bash`，不实现自动转后台、等待工具或自动重试任务。
- 不实现跨 Pi 进程、崩溃、重启、跨会话恢复；不从 PID/JSON 文件接管进程。
- 不新增代理、模型编排、provider 修改或付费模型 smoke test。
- 不新增守护进程或磁盘日志自动清理。`/bg-clear` 只确认提示，不删除日志。
- 不创建 GitHub 远端、不发布 npm；本地可安装即可。

## 2. 接口与兼容策略

- 保持四个 `bg_*` 工具和七个后台命令的名字；fork 不与上游同时加载。
- 使用独立本地包名，暂定 `pi-background-shell`；清理指向上游的更新说明和发布元数据，保留来源和 ISC 许可。
- 删除 `PI_BG_FEATURES`；保留 dock、shell 选择、输出限额等仍有效的配置。
- 删除 `PI_BG_DISABLE_PI_TELEMETRY`、自动更新检查、`/bg-update`、相关网络请求和配置。
- EventBus 去掉必填 `isAgent` 会改变旧契约，因此改用 fork 的 **v2** channels/schema IDs 和 `api_version: 2`，不伪装与上游 v1 兼容、不保留旧 agent 参数适配层。操作集合与通知默认语义不变，capabilities 不再声明 agent 遥测。
- reload 所有权使用固定的 fork 身份，例如 `Symbol.for('pi-background-shell.reload-shell-owner.v1')`，对应 protocol 字符串同步调整；两阶段交接、方法签名和固定截止时间不变，fork 自己的历次激活使用同一个身份。不接管上游存量任务，更换扩展前先停止上游任务。

## 3. 实施步骤

### A. 导入固定基线并记录现有失败

- [x] 在当前目录建立本地 Git 工作树，从上游获取并检出固定 commit，保留本地 `PLAN.md`；不要对已有计划的非空目录执行 `git clone ... .`。
- [x] 导入纯源码/受版本管理的文件，不复制调研目录的 `node_modules`、运行产物或凭据。安装开发依赖时禁用依赖生命周期脚本，构建显式执行。
- [x] 复核上游后台相关测试，单独定位 reload 交接超时测试的失败；修复需有回归证据，不能通过删测试或任意延长等待掩盖。
- [x] 将宿主 SDK/TUI 开发依赖与验证目标调整到 `0.99.1`；宿主库按 Pi 包规范作为 peer 提供，不打包重复 SDK。Node 最低要求暂保留 `>=22.19.0`。

已知基线：此前后台相关抽样 128 项，127 通过；`tests/unit/reload-shell-owner.test.ts` 的 `does not extend the absolute handoff deadline when a claim aborts` 连续两次失败。当前宿主的 shell 启动、终态、状态/日志 smoke test 已通过，但不代表全部兼容验证完成。

执行记录：本轮未修改的上游 owner 测试 7/7 通过，确认此前失败为间歇性。发现提前触发的计时器清空自身句柄后，因尚未到截止时间而直接返回，导致清理不再触发；现改为按原截止时间重新安排。新增 handoff/claiming 两条确定性回归在上游失败、fork 通过；fork owner 测试扩为 11 项并两次全通过。没有延长 30 秒交接窗口。

### B. 整体删除模型工作流及入口

- [x] 删除 `src/delegate-*.ts`、`src/fusion-*.ts`、`src/core/delegate/`、`src/core/fusion/`、`src/core/context/`、`src/ui/fusion-model-selector.ts`。
- [x] 删除 `src/core/attested-pi-*.ts`、`src/core/anthropic-attribution*.ts` 及其入口；删除 `bg_delegate`、`bg_result`、`bg_run_pi_attested`、全部 `fusion_*`、Fusion 命令、`/claude-cache` 和 renderer。
- [x] 删除更新检查及 `src/core/update-check.ts`。移除 `turndown`、`@types/turndown`；按最终引用检查删除无消费者的 `canonical-json.ts` 等辅助模块。
- [x] `package.json.pi.extensions` 只保留 `dist/extensions/background-tasks.js`。

### C. 删除遥测并清理后台内核

关键文件：`src/core/registry.ts`、`src/core/common.ts`、`src/core/reload-shell-owner.ts`、`src/core/extension-api.ts`、`src/extension.ts`、`src/ui/background-tasks-manager.ts`。

- [x] 从工具 schema、参数准备、命令解析、启动选项、任务对象、快照、元数据和 EventBus 请求中移除 `isAgent`；同时删除 `--agent`、`--llm-agent`、`--script`、`--no-agent` 分类选项。旧参数明确报不支持，不在准备参数时静默丢弃或作为命令透传；该检查仅针对扩展工具参数和 `/bg` 前置选项，不检查 `command` 内容或子程序自己的选项。
- [x] 删除 Pi 启动识别、遥测 wrapper 文件生成、命令替换、JSON/控制行解析及模型窗口查询；删除不再使用的 `src/core/pi-launch.ts`。
- [x] **registry 和 reload owner 两套遥测解析均已删除**。移除 `agentStdoutBuffer`、`contextUsageBuffer` 等分片缓冲、模型/context/token/tool 字段、UI 占位行；两个执行路径都直接写普通日志，不吞控制样式或 JSON 行。
- [x] 删除 `finalizeTask` 中仅为 wrapper 保留的 25ms 等待和 stdout 重组/flush；保留真实输出流 close/drain、终态元数据和进程树停止检查，不新增固定等待。
- [x] 删除 managed/Fusion、delegate、attested 的 starter、取消流程、结果取回/usage accounting 以及类型/通知/UI 特殊分支。
- [x] 更新 reload 执行资格和结构检查；保留同一子进程、输出流、绝对超时、累计输出限额、进程组权限、通知及终态发布状态的交接。
- [x] 后台 registry 上下文仅保留 `cwd/sessionId`，不再读取父会话模型、凭据或 model registry。
- [x] 同步更新 EventBus v2 与 fork reload owner 身份，防止旧协议/旧任务对象被误接续。

必须复用而非重写：

- `BackgroundTaskRegistry.startTask/resolveTask/getTaskLogs/stopTask/stopAllRunning`，位于 `src/core/registry.ts`。
- `resolveShellPolicy/shellInvocationForPolicy/parseBgCommandArgs/boundedRead`，位于 `src/core/common.ts`。
- `writeJsonAtomic`（`src/core/task-durable.ts`）、`replaceFileDurable`（`src/core/durable-fs.ts`）。
- `runWindowsTaskkill`（`src/core/windows-taskkill.ts`）和 `src/core/reload-shell-owner.ts` 的现有交接/终止机制。
- `LazyModule`、`SynchronousActivationCloseFence`（`src/core/lazy-module.ts`），保留任务 UI 懒加载和同步关闭保护；裁剪原模型功能的使用点。

### D. description-only 与 UI/输入检查

- [x] 四个工具均不设置 `promptSnippet`、`promptGuidelines`；删除 `src/extension.ts` 的 shell `before_agent_start` 注册。
- [x] `src/core/shell-policy.ts` 只保留初始化和简短工具说明生成，删除 prompt string/array/sections 改写、XML prompt 块和相关宿主兼容代码。
- [x] 激活时以同一份解析好的 shell 配置生成 `bg_run.description`：实际 executable、参数和命令语法；只在真实 `-c` 路径说明没有请求登录参数，不将自定义 `-lc` 误称为非登录。reload 后新任务用新配置，存活任务仍持有旧启动事实。不暴露整个环境变量。
- [x] description 只说明何时使用、立即返回、默认通知/唤醒、不要为等待而轮询、日志上限与非沙箱执行；参数默认值和约束写各自 description，不把旧八条 guidelines 原样拼接。
- [x] 启动回执/终态消息只返回任务事实与通知状态，删除重复操作指导及终态 `<guidance>`；保留终态事件和唤醒机制。
- [x] UI 删除模型使用信息，保留进程字段和日志；自定义 dock 仅在 TUI 打开，RPC/无 UI 模式提供状态/日志路径。
- [x] `timeoutSeconds`、`PI_BG_MAX_OUTPUT_BYTES` 非法值明确失败；stale UI context 按关闭处理。任务变更/周期页脚的非 stale 渲染错误报告后隔离，不中断已启动子进程的所有权；真正的启动/存储/终止错误仍明确失败。

### E. 构建、文档、测试与本地安装

- [x] 更新 `scripts/build-runtime.mjs`，删除子扩展入口检查和 delegate evidence copy，干净重建 `dist/`，杜绝残留旧功能。Git 本地安装保留可用编译入口。
- [x] 裁剪 `scripts/docs/lib.mjs` 的能力组合、Fusion workflows、产物清单、入口/发布硬编码和 schema ID 的包名前缀；保留并收窄 schema/文档一致性验证，不只删除 Markdown。
- [x] `bg_run.description` 使用静态基础说明加运行时 shell 后缀。提取器只支持约定的 `BG_RUN_DESCRIPTION + shellPolicyDescription(shellPolicy)` 组合：文档记录基础说明和后缀规则，SDK 测试验证实际后缀；不固化维护者机器路径，也不执行任意扩展代码提取文档。
- [x] 更新 README、后台工具/命令、shell 配置、reload、安全限制、EventBus v2 文档；调整现有元数据/来源声明。删除代理、Fusion、attribution、attested、遥测和更新文档、生成记录及维护脚本。
- [x] 删除上述专属测试；裁剪混合测试，而不是删除仍覆盖后台可靠性的整个文件。代表路径：`tests/unit/registry.test.ts`、`tests/sdk/sdk.test.ts`、`tests/package/package.test.ts`、`tests/scripted-provider/scripted-provider-extension.ts`。
- [x] 保留 UI、RPC、生命周期、reload、durable fs、进程树清理及 EventBus 的测试。将原提示注入测试替换为 description/shell 执行一致性与无注入测试。
- [x] 修改 package payload、版本/来源断言、脚本及 CI；移除外部 `cd ../..` 工程依赖和无文件可运行的测试 glob。开发依赖和 lockfile 与 fork 一致。
- [x] 保留 ISC 原许可；移除功能的派生代码全部删除后裁剪对应 notice。没有创建远端或执行发布。

## 4. 验证与验收

以下命令仅在批准实施后执行；先调整脚本到纯后台范围，再运行：

```sh
npm run build:runtime
npm run typecheck
npm run docs:generate
npm run docs:verify
npm run test:unit
npm run test:sdk
npm run test:rpc
npm run test:component
npm run test:package
npm run test:agent-loop
npm run test:pty
npm run smoke
npm run pack:dry-run
npm run payload:check
```

重点回归：

- [x] 扩展恰好注册四个后台工具、七个命令；工具/事件 schema、任务类型及快照无 `isAgent`，没有模型工具、provider 注册、更新网络请求、两种 prompt 字段或 shell 系统提示 hook。静态检查区分移除功能与必要的旧参数拒绝提示，不用全仓库关键词零出现代替行为验证。
- [x] Pi `0.99.1` 的工具声明仍含四个工具及 description；不依赖系统提示摘要发现工具。模拟 provider 按工具描述验证“启动 → 结束当前 turn → 终态通知 → 一次后续 turn”，不用真实付费模型。
- [x] 正常/非零退出、spawn 失败、超时、输出超限；头尾日志、截断、未知/歧义 ID、已结束任务 kill 错误。
- [x] stdout/stderr 包括貌似 Pi JSON/控制行、二进制字节、跨块字符和无换行尾片的内容不再被遥测解析丢弃。
- [x] 通知和唤醒所有开关组合、通知去重、终态 metadata/output 关闭顺序；EventBus 响应先于相关终态、发布失败去重与关闭保护。
- [x] 默认 reload 杀任务；显式存活保持同一 ID/PID/输出路径、原超时与累计输出限额；交接期间完成可通知，交接超时正确清理。普通 shell 中运行 Pi CLI 也不被重新分类。
- [x] 关停与启动竞态、重复关停、会话切换、扩展移除/加载失败清理；不扫描 PID/磁盘冒认任务。
- [x] SDK harness 使用 `bindExtensions({ onError, ... })` 等有效绑定和有 `session_shutdown` 的退出路径（例如 `AgentSessionRuntime.dispose()`）；空/仅 mode 绑定的 reload、直接 `AgentSession.dispose()` 不冒充受支持的资源交接或清理流程。
- [x] 组件/SDK 验证 dock 操作、窄屏/Unicode、快捷键关闭；RPC 不挂起；无遥测空行；`/bg-clear` 不删除日志。真实 PTY 另列为未完成。
- [x] POSIX 进程组停止证明与 Windows mock/helper 测试通过；明确区分模拟证据和未验证的原生 Windows 行为。
- [x] 打包及本地安装仅加载后台入口；无已删除功能的 src/dist/依赖残留，不捆绑宿主 SDK。隔离、离线 tarball 安装后验证编译入口和源码入口，不改用户全局设置。
- [ ] 真实 PTY/TUI 交互验证：本机无 `/usr/bin/expect`，8 项明确 skip，不计作交互 UI 通过。
- [ ] 原生 Windows 验证：本机为 Linux；`test:windows` 的 15 项均因平台前置条件拒绝执行，不计为功能验证或已通过。

验收标准：本地可安装、上述后台流程通过，已知 reload 基线失败有明确结论及回归；当前工作区只保留纯后台功能和相应维护资产。正式发布、远端 fork、自动恢复与额外功能不属于本计划。

## 5. 最终本地验收记录

环境：Linux、Node `v24.12.0`、npm `11.7.0`、Pi SDK/AI/TUI `0.99.1`、TypeBox `1.3.27`。最低 Node 声明保留 `>=22.19.0`，本机并未执行其他 Node/Pi 版本或远端 CI。

最后完整 `npm run test:full` 命令成功；真实 PTY 的 skip 仍是验证限制。统计按套件记录，不将单独 type-safety/docs 重跑与 package/unit 的重叠用例累加。

| 检查 | 最终结果 |
| --- | --- |
| Typecheck | 通过 |
| Unit | 150 passed，0 failed |
| SDK | 36 passed，0 failed |
| RPC | 7 passed，0 failed |
| Component | 11 passed，0 failed |
| Package | 33 passed，0 failed；包含 4 项 type-safety |
| 确定性本地 provider agent loop | 8 passed，0 failed；无真实付费调用 |
| 真实 PTY | 8 skipped，0 passed |
| 原生 Windows | 未验证；Linux 平台前置条件拒绝 15 项 |
| 干净 build / docs generate / docs verify | 通过；15 个公开 surface、13 个生产源码文件 |
| 单独 docs gate | 6/6 通过；与 unit/package 中的文档用例重叠 |
| CLI smoke | Pi 0.99.1 在隔离离线环境激活编译入口，四个工具及七个命令检查通过 |
| Prepack dry-run / payload check | 通过；67 个打包文件，精确源码/JS/map/deferred closure，无捆绑宿主 SDK |
| 来源/许可/工作树检查 | ISC LICENSE 与基线 SHA-256 相同；`git diff --check` 通过，无远端 |

收尾修正：

1. Reviewer P1 已修复：非 stale 页脚错误不再从 registry `onChange` 或周期回调逃逸，避免已启动 child 被误标失败而失去可停止的所有权。新增 SDK 回归实际触发启动与周期两处渲染失败，确认任务仍 running、可 kill，PID 最终不存在。
2. 超时限定为 `1..2_147_483` 秒并向下取整，防止 Node timer 溢出立即触发；工具、普通/reload registry、EventBus 及生成 schema 一致。输出 cap 必须为正安全整数。
3. 完成通知删除 `<guidance>` 和操作指令，仅保留任务事实；description-only 的 provider follow-up 回归通过。
4. 原始输出测试曾偶现合法的原子元数据临时文件。现等待既有 `metadataWriteChain` 再断言最终目录恰有 `.json/.output`；没有放宽最终断言、修改生产顺序或增加固定 sleep。完整套件通过后，该用例又在独立进程连续 5 次通过；不与完整套件重复累加。
5. CLI smoke 使用 ESM `import.meta.resolve` 与真实 bin 元数据；CLI 参数是 `--no-builtin-tools`，不是关闭所有扩展工具的 `--no-tools`。以全部断言通过后生成的临时 receipt 验证激活，不依赖 print-mode 通知/重定向输出。

日志：完整最终测试 `/tmp/bg-shell-final-tests.log`；最后 smoke/prepack/payload `/tmp/pi-processes-UayeSc/proc_1-stdout.log`（临时日志，非发布资产）。

交付：源码、跟踪的 `dist/`、文档、lockfile、测试和 CI 均已更新；`README.md` 给出不改全局配置的 `pi -e ./dist/extensions/background-tasks.js` 使用方式。没有发布 npm、创建远端、修改用户全局设置或创建新的实施提交。

## 6. 追加：工具改为延迟注册（deferred）

用户要求在本地部署后追加一项变更：四个工具不再直接声明，改为 Pi 的延迟注册，并要求最小改动。

实施：

- `src/extension.ts` 增加模块级 `BG_TOOL_NAMESPACE`（`background-shell`），四个 `registerTool` 各加 `exposure: 'deferred'` 与 `namespace`。工具名、schema、description 不变，只是不再进入模型每轮的声明集合。
- 模型通过 `tool_search` 发现并加载它们（`tool_search` 的 description 会列出该 namespace 作为可搜索来源），或在 `codemode` 脚本中直接调用。扩展不改动宿主工具集。
- `/bg`、`/jobs`、`/logs`、`/kill` 是用户斜杠命令，快捷键与 dock 同理，均不受 exposure 影响，任何情况下都可用。
- 未新增启动警告、未改动 gate 提取契约、未重写 provider 流程。生成的工具文档因源码行号与哈希变化而重新生成，内容不变。

测试改动保持最小：`tests/sdk/sdk.test.ts`、`tests/sdk/dock-sdk.test.ts`、`scripts/smoke.ts` 的断言由“四个工具已激活”改为“已注册为 deferred 且未声明”；`tests/scripted-provider/*` 两个 harness 各加一行 `setActiveToolsByName` 使工具进入声明集合，provider 文件未改。`tool_search` 实际加载命名空间的路径为手工验证（返回 `loaded: [bg_kill, bg_status, bg_logs, bg_run]` 且随后激活），没有自动化用例。

验证：typecheck、unit 150、SDK 36、RPC 7、component 11、package 33（含 4 项 type-safety）、agent-loop 8 全部通过；真实 PTY 仍 8 项 skip，原生 Windows 仍未验证。`docs:verify`、`smoke`、`pack:dry-run`（67 文件）、`payload:check` 通过。日志：`/tmp/bg-min-full.log`。

## 7. 追加：CHANGELOG.md

新增仓库根目录 `CHANGELOG.md`：记录 fork 基线（`pi-background-tasks@2.6.8` / commit `471f1dc`）、删除项、保留项与本次改动。为避免重复，`UPSTREAM.md` 的删除清单改为指向该文件，只保留来源事实；`CHANGELOG.md` 与 `PLAN.md` 一样是仓库文档，不进入 npm payload（仍为 67 个文件）。
