# 开发与测试

## 环境与命令

基线：Node ≥22.19、Pi **1.0.0**、TypeBox **1.3.27**。仅在本工作区安装开发依赖：

```sh
npm ci --ignore-scripts --include=optional --legacy-peer-deps
npm run check
npm test
npm run build
npm run verify
```

`check` 调用各 workspace 的严格检查并检查根脚本语法；`npm test` 先构建完整产物，
再执行分模块套件及根集成测试；`verify` 组合两者。任一步骤失败即失败，
不以重试隐藏结果。集成测试使用真实宿主 loader 与临时 release 目录，不需要
registry。

调试单个包或套件：

```sh
node scripts/test.mjs --package pi-loop
node scripts/test.mjs --package pi-background-shell
node scripts/test.mjs --package pi-subagents
node scripts/test.mjs --suite integration
node scripts/test.mjs --package pi-subagents --list
```

subagents 保留 Vitest 4.1.10 的原有 mocking/fake-timer 套件；其他包及根集成
使用 node:test。根 runner 按 `serraly.test` 分派各包的 testCommand，并为 subagents 启用网络拒绝；
`--list` 只发现测试文件，不执行 Vitest 或写构建产物。定向调试同样复用隔离：

```sh
node --input-type=module -e '
  import { isolatedRun } from "./scripts/lib/workspace.mjs";
  await isolatedRun("npm", ["exec", "--workspace=extensions/pi-subagents", "--", "vitest", "run", ...process.argv.slice(1)], undefined, { denyNetwork: true });
' -- test/agents/extension-selection.test.ts
node --input-type=module -e '
  import { isolatedRun } from "./scripts/lib/workspace.mjs";
  await isolatedRun(process.execPath, ["--test", ...process.argv.slice(1)]);
' -- test/integration/runtime.test.mjs test/integration/subagents-runtime.test.mjs
```

定向根测试需要已有完整的 `npm run build` 产物；根 runner 自动重建。
模块选择只用于调试，不代替完成前的 `npm run verify`。
入口路径和构建策略见[架构](architecture.md)。
后台 shell 的源码或人类文档变更经审阅后，先运行
`npm run docs:generate --workspace pi-background-shell` 更新哈希管控产物，
再运行完整验证；生成哈希不替代行为审阅。

## 测试层级与质量要求

1. **领域单测**：解析/校验、预检和报告、预算、时序、状态转换；期望由手工
   fixture 或契约推导，不调用被测 helper 计算另一侧“期望”。
2. **模块边界测试**：实际注册定义、renderer、文件/进程/worker 和宿主 SDK。
   外部或慢操作才允许 test double；保留真正影响断言的副作用。
3. **产物集成**：实际编译入口、release 树、新路径 lazy import、宿主 loader
   和类身份、资源过滤、七入口共存、脚本化 child 与合成 stdio MCP。
4. **操作演练**：临时目录内真实文件锁、原子发布和故障中断恢复。
5. **人工交互**：目标终端的视觉、快捷键、鼠标和焦点；自动渲染宽度检查不替代它。

新增功能和 bugfix 先写能捕获具体错误的测试，观察 RED，再写最小实现并验证
GREEN。测试名说明破坏的行为。不得用源码字符串匹配代替执行脚本或接口验证，
不得删除保留行为测试来获得全绿，也不对人类文档的措辞做脆弱快照。

定时/取消用可控时钟、事件或明确完成条件；进程/worker 测试有期限及 finally
清理。只在平台能力确实缺失时明确 skip；缺产物、错误版本或 native 加载失败
是 failure，不是静默 skip。

## 隔离规则

根 runner 为每个 suite 创建临时 HOME/agent/config/cache；环境为 allowlist，
不继承真实 provider keys、session pointers、NODE_OPTIONS 或代理端点。
`scripts/lib/environment.mjs` 拥有该 allowlist 与测试控制转发，
`scripts/lib/host.mjs` 拥有固定 1.0.0 宿主的查找，`scripts/lib/process.mjs`
拥有有期限的子进程执行；UI 预览与捕获在这之上显式设置自己的 stage/report
路径，通用环境不携带预览字段。
运行时测试使用空工作目录/本地合成 fixture、内存会话及脚本化 provider。
实际 CLI/SDK worker 使用离线模式和网络拒绝 preload；拒绝环境继承到每个
运行时子进程，包括合成 MCP。离线模式本身不禁止模型请求。
即使测试捕获了网络异常，guard 记录仍使该场景失败。

不得读真实 auth、sessions 或 settings；不得发送真实模型请求。
模块 tests 自己拥有进程/worker 清理。

实际 CLI 基线来自开发树外的全局 **1.0.0** host；必要时可显式指定另一份
同版本安装：

```sh
PI_UI_HOST_PACKAGE=/absolute/path/to/pi-coding-agent npm run verify
```

该变量只选择宿主包代码，不选择用户配置。根集成测试从独立 release 通过宿主
loader 加载，不能用源码 workspace 的 ESM import 冒充最终运行验证。

## UI 预览

```sh
node scripts/preview.mjs regular
node scripts/preview.mjs fullscreen rich
node scripts/capture.mjs /tmp/pi-ui-captures
```

仅临时数据；覆盖范围见 [UI 验收说明](../extensions/pi-ui/docs/acceptance.md)。
编译 release 的 CLI 集成使用真实宿主 PTY，覆盖 regular/fullscreen 的 40/80/120
列、专用子代理 renderer 和 host class identity。自动宽度/ANSI 断言不替代人工
视觉、输入和焦点验收；无 PTY 或未人工查看时必须如实报告。

## 运行包

完整 verify 后，在开发树外准备新版本目录。发布以 `package.json` 的 `version`
命名（目录与 `release.json.buildId`），所以**发布前先递增 `version`**：

```sh
npm run release                                  # → ~/.local/share/pi-Serraly/releases/<version>
# 只交付部分扩展；重复 --package 选择子集，默认七个全部
npm run release -- --package pi-ui
npm run release -- --package pi-ask-user-question --package pi-subagents
# 显式覆盖（临时验收目录或特殊 build id）
npm run release -- --build-id <id> --output /absolute/path/to/new-release
```

选择在创建目标目录、构建或启动任何子进程之前校验：空名称、重复、未知名称和库
名称都会直接失败。release 默认包含七个扩展；聚合 manifest 只声明被选中的入口，
`release.json` 记录每个成员的路径与封印摘要。

release 不安装运行依赖、不携带 lock 或 `node_modules`，只复制已验证的 payload。
目标路径不能包含符号链接或发现目录，也不能继承祖先的物理宿主；聚合 manifest、
成员封印和整体 digest 必须通过。既有目录拒绝覆盖，这一步**不**修改 Pi settings
或 extensions。

每个扩展同时是独立 npm 包：集成测试对每个包执行真实 `npm pack`，在开发树外的
consumer 目录里以 `--offline --ignore-scripts --legacy-peer-deps` 安装本地 tarball，
再由开发树外的真实宿主 loader 加载。该 fixture 证明包的独立性与 bundled 闭包，
不投影 registry 依赖图，也不安装宿主 peer。

## 版本门禁

每个包独立版本。发布面（包内源码、构建配方、manifest、打包 payload 与随包文档）
变化后必须提高该包版本；只有包内测试或仓库根人类文档变化时可以不动版本。
被 bundle 的库升版时，必须同时更新消费者的精确依赖并提高消费者版本，因为它的
封印 payload 已变。根 release-set 版本独立于各包。

```sh
npm run check:package-versions -- --base <git-ref> [--head <git-ref>]
```

基线只读取 Git 中的包身份（名称/版本/依赖名），因此旧提交不需要当前的
`serraly` schema；不查询远端分支或 npm。共享构建脚本的产物影响由审阅判断，
门禁不声称自动推断语义。包移动目录后仍按名称识别原版本。

## 更新与回滚

已安装的 Pi 通过 settings `packages` 引用 release 绝对路径；更新发布新的版本
目录并切换引用，不覆写正在使用的目录，也不用 `pi install .` 加载源码根。真实
settings 切换需要单独授权，并满足以下约束：

1. 递增根版本并发布新目录，完成 verify、release validation、外部宿主启动
   检查和 CLI/SDK 验收。Node 最低版本 22.19 未实跑、平台 skip 或
   未人工查看的 PTY 必须列为资格缺口，不能用较新 Node 的成功替代最低基线。
2. 停止所有相关 Pi 实例，确认 child 与 MCP/后台资源已关闭；备份 user settings
   与相关已信任项目 settings 的精确内容。
3. 切换只改 `packages`：先校验目标 release 的 manifest 与 digest，再按 Pi 的
   settings 锁协议原子写入，写入后确认引用恰好一条且不影响其他条目。
4. 启动后核对受影响入口各注册一次、无冲突诊断，再恢复正常工作。
5. 回滚恢复备份 settings 并指回旧版本目录；新旧 release 和备份都保留供检查，
   **不覆写**，不把内存会话假定为可跨重启恢复。配置保留
   `<agentDir>/subagents-lite.json`、`subagents-lite-prompt.md`、`agents/*.md`
   及项目中的对应文件，不删除或重命名。
