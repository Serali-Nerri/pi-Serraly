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
不以重试隐藏结果。release 安装边界测试执行真实 `npm ci`，需要可用 registry
或缓存，只获取锁定包。

调试单个 suite：

```sh
node scripts/test.mjs --module loop
node scripts/test.mjs --module docparser
node scripts/test.mjs --module integration
node scripts/test.mjs --module background-shell --list
```

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
3. **产物集成**：实际编译入口、runtime-only 安装、新路径 worker/lazy import、
   宿主 loader 和类身份、资源过滤、七入口共存。
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
运行时测试使用空工作目录/本地合成 fixture、内存会话及脚本化 provider。
实际 CLI 使用离线模式和网络拒绝 preload；离线模式本身不禁止模型请求。

不得读真实 auth、sessions 或 settings；不得发送真实模型请求。原生文档
fixture 关闭 OCR，不安装系统包。模块 tests 自己拥有进程/worker 清理。

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

仅临时数据；覆盖范围见 [UI 验收说明](../modules/ui/docs/acceptance.md)。
自动化结果不替代人工视觉验收。

## 运行包

完整 verify 后，在开发树外准备新版本目录。发布以 `package.json` 的 `version`
命名（目录与 `release.json.buildId`），所以**发布前先递增 `version`**：

```sh
npm run release                                  # → ~/.local/share/pi-Serraly/releases/<version>
# 显式覆盖（临时验收目录或特殊 build id）
npm run release -- --build-id <id> --output /absolute/path/to/new-release
```

release 投影统一锁的运行依赖图，执行
`npm ci --omit=dev --legacy-peer-deps --include=optional --ignore-scripts`，
保留 LiteParse 平台 binding。目标路径不能包含符号链接或发现目录，也不能继承
祖先的物理宿主；manifest、运行锁、dist digest 和 OCR-off native PDF 探测
必须通过。既有目录拒绝覆盖，这一步**不**修改 Pi settings 或 extensions。

已安装的 Pi 通过 `packages` 引用 release 绝对路径。更新时发布新的版本目录并在
Pi 锁下切换引用，不覆写正在使用的目录，也不用 `pi install .` 加载源码根。
