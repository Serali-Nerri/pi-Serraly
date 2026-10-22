# 开发与测试

## 环境与命令

基线：Node ≥22.19、Pi **1.3.0**、TypeBox **1.3.27**。仅在本工作区安装开发依赖：

```sh
npm ci --ignore-scripts --include=optional --legacy-peer-deps
npm run verify
```

合并或切换分支后，若工作区目录或 lock 有变化，重新执行 `npm ci`，清除旧依赖
与旧工作区链接；不要沿用旧 `modules/*` 布局的 `node_modules`。

`build` 是唯一的构建入口；`check` 只调用严格检查及根脚本语法检查，
`npm test` 只执行测试，不隐式重建。`verify` 顺序执行 build、check、test，
一次构建已包含封印及包级 artifact 校验，不再重复 pack:check。任一步骤失败即失败，
不以重试隐藏结果。集成测试使用真实宿主 loader 与临时 release 目录，不需要
registry。

调试单个包或套件：

```sh
node scripts/test.mjs --package pi-ui
node scripts/test.mjs --package pi-ui --list
node scripts/test.mjs --suite integration
```

包测试及根集成使用 node:test。根 runner 按 `serraly.test` 发现各包测试。
真实 AgentSession、公开命令与
TUI 输出使用隔离内存 settings/auth/session 和请求局部脚本化 transport，不连接
provider。`--list` 只发现测试文件，不执行测试或写构建产物。定向调试同样复用隔离：

```sh
node --input-type=module -e '
  import { isolatedRun } from "./scripts/lib/workspace.mjs";
  await isolatedRun(process.execPath, ["--test", ...process.argv.slice(1)]);
' -- test/integration/runtime.test.mjs
```

涉及编译产物的定向测试需要先构建受影响的包，例如
`npm run build --workspace pi-ui`（自动先构建它依赖的库）；不涉及产物的源代码测试
不需要构建。根集成测试需要完整产物。测试与 release 组装不暗中修复缺失或损坏的
产物，修改源代码后由调用方显式重建。
RED/GREEN 只运行新增或失败的测试文件；功能完成后运行受影响包及直接消费者。
一次完整变更收尾时运行 `npm run verify`，不在每个小步骤、每个提交后重复全量。
同一代码、锁文件和运行环境已有成功记录时复用结果，只补缺口。
入口路径和构建策略见[架构](architecture.md)。
## 测试层级与质量要求

1. **领域单测**：解析/校验、预检和报告、预算、时序、状态转换；期望由手工
   fixture 或契约推导，不调用被测 helper 计算另一侧“期望”。
2. **模块边界测试**：实际注册定义、renderer、文件/进程/worker 和宿主 SDK。
   外部或慢操作才允许 test double；保留真正影响断言的副作用。
3. **产物集成**：实际编译入口、release 树、新路径 lazy import、宿主 loader
   和类身份、资源过滤、脚本化 child 与合成 stdio MCP。CLI 的模块
   计时器/UI 守卫按当前 release 成员路径归属调用，并有能触发计数的正向控制。
4. **操作演练**：临时目录内真实文件锁、原子发布和故障中断恢复。
5. **人工交互**：目标终端的视觉、快捷键、鼠标和焦点；自动渲染宽度检查不替代它。

新增功能和 bugfix 先写能捕获具体错误的测试，观察 RED，再写最小实现并验证
GREEN。测试名说明破坏的行为。不得用源码字符串匹配代替执行脚本或接口验证，
不得删除保留行为测试来获得全绿，也不对人类文档的措辞做脆弱快照。

定时/取消用可控时钟、事件或明确完成条件；进程/worker 测试有期限及 finally
清理。fixture 启动的 detached 进程自身也有短于外层 worker 的期限，断言失败时
释放完成 gate，不能只依赖 worker 内的计时器或 shutdown。真实 SDK 的停止响应
等待须覆盖完整 tree-stop/proof 预算及有界的收尾余量，
不能假定 POSIX 收到 TERM 就已停止；通过就绪信号确保强制终止场景确实运行。
只在平台能力确实缺失时明确 skip；缺产物、错误版本或 native 加载失败
是 failure，不是静默 skip。

## 隔离规则

根 runner 为每个 suite 创建临时 HOME/agent/config/cache；环境为 allowlist，
不继承真实 provider keys、session pointers、NODE_OPTIONS 或代理端点。
`scripts/lib/environment.mjs` 拥有该 allowlist 与测试控制转发，
`scripts/lib/host.mjs` 拥有固定 1.3.0 宿主的查找及 release/预览共用的版本事实，`scripts/lib/process.mjs`
拥有有期限的子进程执行；UI 预览与捕获在这之上显式设置自己的 stage/report
路径，通用环境不携带预览字段。
隔离构建、检查、测试与打包的 npm 子进程强制离线，并关闭更新通知、audit 与 fund；
registry 访问只属于显式依赖安装阶段，不继承操作者的 npm 配置。
运行时测试使用空工作目录/本地合成 fixture、内存会话及脚本化 provider。
实际 CLI/SDK worker 使用离线模式和网络拒绝 preload；拒绝环境继承到每个
运行时子进程，包括合成 MCP。离线模式本身不禁止模型请求。
即使测试捕获了网络异常，guard 记录仍使该场景失败。

不得读真实 auth、sessions 或 settings；不得发送真实模型请求。
模块 tests 自己拥有进程/worker 清理。

UI renderer 夹具通过目标宿主的公开 resolver 链解析，并在交互入口合并内置
renderer；原始工具定义的存在不代表它已经提供 renderer。静态 HTML 验收调用
真实 `AgentSession.exportToHtml()`，检查实际导出正文，不以消息数据读取代替。

实际 CLI/SDK 验收使用开发树外的 **1.3.0** host：显式 `PI_UI_HOST_PACKAGE`
优先，其次从 `PI_MANAGED_INSTALL_ROOT/current-version` 定位 managed release，
仅在没有 managed 安装指示时使用当前 Node 的全局 npm 安装。显式配置无效时失败，
不能悄悄换成另一份宿主。必要时指定另一份同版本安装：

```sh
PI_UI_HOST_PACKAGE=/absolute/path/to/pi-coding-agent npm run verify
```

该变量只选择宿主包代码，不选择用户配置。根集成测试从独立 release 通过宿主
loader 加载，不能用源码 workspace 的 ESM import 冒充最终运行验证。
显式或 managed 安装指示存在时，隔离前解析宿主位置，只向子进程传递代码路径，
不传递真实配置；无安装指示的静态检查和源码测试不查找外部宿主。实际 CLI/SDK
验收仍由宿主查找器校验当前 Node 的全局安装，缺少宿主时直接失败。managed 安装
不必拥有独立 Node；使用实际启动 Pi 的运行时验收，不因该 Node 来自 nvm 而再跑一遍。

## UI 预览

```sh
node scripts/preview.mjs regular
node scripts/preview.mjs fullscreen rich
node scripts/capture.mjs /tmp/pi-ui-captures
```

仅临时数据；覆盖范围见 [UI 验收说明](../extensions/pi-ui/docs/acceptance.md)。
编译 release 的 CLI 集成使用真实宿主 PTY，覆盖 regular/fullscreen 的 40/80/120
列和 host class identity。自动宽度/ANSI 断言不替代人工
视觉、输入和焦点验收；无 PTY 或未人工查看时必须如实报告。

工作汇总的 scrollback 验收以真宿主主屏和记录终端写入的 Adapter 为 Seam：
稳定长正文上推进汇总时钟，不能周期性清空终端历史。

## 分支与发布通道

`main` 是稳定分支，只接收经过审阅、完整验证并完成试用观察期的版本；`dev`
承载预览。预览的根 release-set 版本必须带 prerelease 标识（例如
`0.3.0-preview.1`）；晋升到 `main` 只交付已审阅、已验证的版本，不把未验收的
开发树整体当作稳定版本。两个通道都使用不可变的版本化 release 目录；真实配置
切换仍须单独授权、验证备份可恢复，并以恢复备份回滚，见[更新与回滚](#更新与回滚)。

## 运行包

完整 verify 后，在开发树外准备新版本目录。发布以 `package.json` 的 `version`
命名（目录与 `release.json.buildId`），所以**发布前先递增 `version`**：

```sh
npm run release                                  # → ~/.local/share/pi-Serraly/releases/<version>
# 默认交付全部扩展；--package 显式选择当前唯一扩展
npm run release -- --package pi-ui
# 显式覆盖（临时验收目录或特殊 build id）
npm run release -- --build-id <id> --output /absolute/path/to/new-release
```

选择在创建目标目录、构建或启动任何子进程之前校验：空名称、重复、未知名称和库
名称都会直接失败。release 默认包含全部扩展（当前为 pi-ui）；聚合 manifest 只声明被选中的入口，
`release.json` 记录每个成员的路径与封印摘要。

release 不构建、不安装运行依赖、不携带 lock 或 `node_modules`，只复制已构建并
验证的 payload；缺失或篡改产物直接拒绝。正式交付前的 verify 已负责构建，
测试 fixture 也复用同一轮产物，不对每个临时 release 重复编译。
目标路径不能包含符号链接或发现目录，也不能继承祖先的物理宿主；聚合 manifest、
成员封印和整体 digest 必须通过。既有目录拒绝覆盖，这一步**不**修改 Pi settings
或 extensions。

每个扩展同时是独立 npm 包：集成测试对每个包执行真实 `npm pack`，在开发树外的
consumer 目录里以 `--offline --ignore-scripts --legacy-peer-deps` 安装本地 tarball，
再由开发树外的真实宿主 loader 加载。该 fixture 证明包的独立性与 bundled 闭包，
不投影 registry 依赖图，也不安装宿主 peer。

## Node 门禁与本地验收

所有根入口（`check`、`build`、`test`、`pack:check`、`release`）在开始任何工作前
调用同一个 `scripts/lib/node-version.mjs` 门禁：低于 `>=22.19.0` 的运行环境直接
失败并说明基线，不做降级、重试或“跳过该项”。无法解析的版本字符串同样 fail
closed。包 manifest 的 `engines.node` 与该门禁必须一致。

本地验收使用统一根入口：

```sh
npm ci --ignore-scripts --include=optional --legacy-peer-deps
npm run verify
```

本仓库不配置 CI。使用实际启动 managed Pi 的运行时完成本地验收，
`>=22.19.0` 保留为工具链启动下限，不作为本项目每次交付的多版本资格声明。
不另外安装 Node 22.19 或重复切换 nvm 验收；若以后承诺分发到不同运行时，
再明确对应的兼容性验收目标。registry 访问仅属于显式依赖安装阶段，
测试与 release 阶段保持网络拒绝。

## 更新与回滚

已安装的 Pi 通过 settings `packages` 引用 release 绝对路径；更新发布新的版本
目录并切换引用，不覆写正在使用的目录，也不用 `pi install .` 加载源码根。真实
settings 切换需要单独授权，并满足以下约束：

1. 递增根版本并发布新目录，完成 verify、release validation、外部宿主启动
   检查和 CLI/SDK 验收，记录实际宿主/Node 版本。平台 skip 或未人工查看的
   PTY 必须如实列出，不额外制造未承诺的 Node 版本矩阵。
2. 备份 user settings 与需要修改的已信任项目 settings 的精确内容，并验证备份
   可原样恢复。切换引用不要求停止正在运行的 Pi 实例，不终止会话或 child/MCP
   资源，也不自动触发热重载。
3. 切换只改 `packages`：先校验目标 release 的 manifest 与 digest，再按 Pi 的
   settings 锁协议原子写入，写入后确认引用恰好一条且不影响其他条目。
4. 已运行实例继续使用已加载的代码；下次完整启动加载新 release。核对新启动的
   受影响入口各注册一次、无冲突诊断。
5. 回滚恢复备份 settings 并指回旧版本目录；新旧 release 和备份都保留供检查，
   **不覆写**，不把内存会话假定为可跨重启恢复。
