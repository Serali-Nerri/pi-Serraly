# 仓库架构

## 七个维护边界

根 package 是资源清单和开发工作区，不是总 extension factory。
每个模块仅注册自己的能力；关闭一个入口不会通过总工厂间接重新启用它。

| 模块 | 拥有的资源 | 不拥有 |
| --- | --- | --- |
| `ui` | 展示生命周期、私有兼容补丁、shell、Markdown、Thinking、`/context` | 业务工具定义、执行和后台进程 |
| `questions` | `AskUserQuestion` schema、对话框、AFK、答案/results、专用 renderer | UI 总体刷新或其他 overlay |
| `loop` | `/loop` 解析、内存任务、忙闲调度、`local-loop` | UI scheduler、持久化恢复 |
| `tools` | `apply_patch` 补丁算法、文件锁、预检、提交、`apply_patch.v1` 报告；`grep`/`find`/`ls` 同名替换的 codemode 注册 | UI 历史 diff 重建 |
| `background-shell` | 进程/日志、dock、通知、状态、同进程 reload handoff | 跨进程恢复或 UI 工具卡接管 |
| `add-dir` | 目录作用域与存储、外部指令 prompt section、skill 路径发现、`@` 补全包装、目录 widget | 模型工具、自动 reload、cwd 切换或工具权限 |
| `subagents` | `Agent`/`StopAgent`/`AgentStatus`、`/agents`、子会话选择/准入/可信状态、调度与关闭、专用展示 | 父工具闭包、兄弟模块私有实现、共享 MCP 连接池或跨进程任务恢复 |

共享库只承载两侧都必须逐字一致的构建期契约，不承载任一方的策略：

| 库 | 拥有的契约 | 不拥有 |
| --- | --- | --- |
| `pi-apply-patch-protocol` | `apply_patch.v1` 格式标识、四项输出预算、`ApplyPatch*` wire 类型 | 生产者的 diff 算法/工作量预算/截断策略，消费者的防御阈值/清洗/降级 |
| `pi-config-core` | 有界 JSON 读取与原子写入机制（大小/UTF-8/权限/并发语义） | 缺失/损坏/不可信文件的错误与信任策略、字段合并、路径与文件名 |
| `pi-ui-kit` | 工具卡公共语法：标题/摘要行、结果状态行、语义主题角色、宽度安全 padding 与按宽度缓存的行组件 | 正文与 diff/IO 预览、hover/hitbox、展开状态、动画帧、renderer 注册和业务信息 |

工具契约和详细算法留在各模块 README/子系统文档。UI 的私有宿主访问只在
`extensions/pi-ui/src/compat/`；其 host 事件只由 `src/lifecycle.ts` 注册。
UI 的共享 scheduler 不管理 loop 定时器、后台进程或子会话资源。

UI 在修改 thinking/transcript 前先做一次无副作用的宿主能力预检（只读
descriptor/继承/extensibility，不执行 getter、不写槽位）：缺少必需方法、
方法不可替换或原型不可扩展时跳过整个兼容域，保留原生展示、shell、命令与
Markdown，每 session 只通知一次并列出能力名；安装器保留就地检查以覆盖预检后
的竞态，失败按逆序释放已获取的部分。预检只覆盖公开方法，不声称能验证私有
instance 字段布局，实际宿主与人工视觉验收仍必需。同一预检还校验补丁槽位的
所有权：本模块写入的 owner/pipeline 带 `Symbol.for("pi-serraly.ui.patch-owner")`
品牌，未标记的值（即使带 `dispose`/`stop` 或形状相似）视为 foreign，不调用、
不接管、不覆盖，兼容域在修改任何槽位前整体失败并只通知一次具体槽位名；上游
槽位名保留用于发现冲突，不自动兼容未知 patch。安装后外部替换 wrapper 或槽位
时，shutdown 按 identity 只释放自己写入的值。

## 源码与运行树

```text
extensions/pi-*/      七个 private npm workspace；源码、测试、包文档/许可、dist/
packages/pi-*/        构建期共享库；无 Pi 资源入口
scripts/              工作区命令、单包构建/封印和 release 组装
test/integration/     产物、实际 loader、子会话和七入口共存
docs/                 跨模块设计与开发
```

工作区统一 npm 锁定。开发宿主是精确 Pi 1.0.0、TypeBox 1.3.27。
宿主提供的包以 `peerDependencies: "*"` 声明并 external，不能作为正式包的
物理运行依赖。workspace 内的开发宿主副本不得延伸到正式运行树。

### 工作区清单

根 `workspaces` 只声明本项目的一级 glob（`extensions/*`、`packages/*`）；
未匹配的 glob 视为空，不报错。包目录名与 npm 包名解耦，包的身份来自自身
manifest。每个 workspace 包必须是真实目录（非链接）、`private`、`type: module`、
`engines.node: ">=22.19.0"`，并声明非空 `files` allowlist。

包元数据只有 manifest 的 `serraly` 一处：

```ts
type BuildRecipe =
  | { kind: "bundle"; entry: string; cjsRequire?: boolean }
  | { kind: "tsc"; project: string }
  | { kind: "script"; script: string; verifyArtifact?: string;
      bundles?: Record<string, { output: string; packages: string[] }> };
interface SerralyMetadata {
  build: BuildRecipe;
  licenses: string[];
  bundledLicenses?: { package: string; file: string; from?: string; to: string }[];
  test?: { directory: "test" | "tests"; command?: string; denyNetwork?: boolean; concurrency?: number; exclude?: string[] };
}
```

依赖方向：扩展（`extensions/*`）只能依赖库（`packages/*`），库不依赖扩展，
库之间目前无依赖。内部依赖必须用精确版本写在 `devDependencies` 并随产物
bundle；`dependencies` 必须为空，`peerDependencies` 只列宿主。构建顺序来自
该依赖图（先依赖后使用者），拒绝缺依赖、版本不符、循环、跨扩展依赖、越界入口
和符号链接 workspace。

`pi.extensions` 入口必须是包内 `./dist/` 下的 `.js` 路径；扩展必须声明至少
一个入口，库不声明 Pi 资源。

正式运行包位于开发依赖树之外的不可变 release 目录，只有运行 manifest、
dist 和许可。它没有运行依赖安装、lock、`node_modules`、workspace 链接或
开发工具，也不声明技能/模板/主题资源。

## 构建闭包

- UI、questions、loop、tools 是独立 ESM bundle；`diff@8.0.4` 打入补丁
  bundle 并携带其 BSD 文本。
- background-shell 用 tsc 编译完整 `extensions/` + `src/`，保留 lazy import；
  根入口只是同目录转发，不另行注册能力。唯一例外是 manifest 声明的
  `src/ui/tool-cards.ts` 叶（见下），其余文件仍是逐文件 tsc 产物。
- add-dir 的主入口 bundle 将 `@henryqw/pi-config-store@2.0.2` 及其 CJS 锁依赖
  全部打入产物，不增加根运行依赖。
- subagents 是独立 ESM bundle，保留上游 MIT 许可及固定来源；Pi SDK、pi-ai、
  pi-tui 和 TypeBox external，不增加运行依赖或额外 worker。
- tools 与 ui 各自 bundle 同一份 `pi-apply-patch-protocol`：wire 常量与类型只有
  该库一处定义，两侧只保留各自的算法、阈值与展示策略。契约一致性由根
  一致性套件用真实生产者输出与真实消费者解析器互验，不做常量自证。
- ui 与 subagents 各自 bundle 同一份 `pi-config-core`：读取上限 64 KiB、严格
  UTF-8、`0600` 文件、`0700` 新父目录和 `<pid>.<uuid>` 临时名只在该库一处实现；
  加载失败回退、保存前重读合并、项目层信任状态和 log/throw 语义仍各自保留。
  add-dir 继续使用自己的异步锁定 store，不迁移到该库。
- ui、questions、background-shell 与 subagents 共用 `pi-ui-kit` 的卡语法：`● title
  summary` 标题行与 `  ⎿ message` 结果状态行只有该库一处定义，运行/成功/失败/取消
  用语义主题角色和状态文字区分，不集中任何 renderer。ui、questions、subagents
  直接 bundle 该库；background-shell 的 `src/ui/tool-cards.ts` 是唯一引用 kit 的
  无状态叶（只接收展示输入，不读 registry/config），tsc 之后由共享 builder 按
  manifest 的 `serraly.build.bundles` 把它内联为同一位置的
  `dist/src/ui/tool-cards.js`：宿主包 external、多源 source map、kit 许可复制到
  `dist/licenses/<library>/`。构建期 gate 只允许该叶引用已声明的 workspace 包，
  编译闭包中不允许残留裸 workspace import。
- 在非发现暂存目录构建，检查 emitted import 图、必要许可和文件哈希后才发布
  开发 dist。许可检查使用完整的必需文件清单，不以目录存在代替法律闭包。
- 每个包先在同级 `.build-dist-*` 候选目录编译（与 live `dist` 同深度，保证
  emitted source map 在最终位置仍解析回包内源码），再原子替换 live dist；
  替换后写入封印并运行包自带的 artifact 校验器和通用 source 校验，任一步失败
  都恢复旧的完整 dist，不留下候选或封印残余。封印（`dist/artifacts.json`）
  记录本次真实 pack 清单除自身外的每个文件及其 SHA-256。
- 封印校验分两侧：构建侧对本次真实 pack 清单逐个比对，部署侧按全部物理文件
  严格比对，拒绝额外文件、symlink、非普通文件和逃逸 import。
- bundle 输入归属按 realpath 检查实际输入：包内源码、第三方 devDependency 与
  经 `exports` 解析的内部库 dist 允许；宿主包、退役依赖、兄弟扩展、库私有
  源码和包外相对路径均拒绝。被 bundle 的内部库按其 `serraly.licenses` 复制到
  消费者的 `dist/licenses/<library>/`。
- 分析所有 emitted JS/MJS/CJS，仅允许读取同一已遍历的常规文件集及声明的
  externals。编译后文件 import 使用普通显式路径；URL 编码、query/fragment、
  反斜杠和控制字符 specifier 均保守拒绝，避免文件系统路径与原生 ESM URL
  指向不同实现。
- release 不执行任何依赖安装，检查自身及所有祖先的物理宿主、拒绝路径中的
  符号链接，并要求运行树不含 `node_modules`、链接或非普通文件；manifest 与
  dist 完整性记录共同绑定 release digest。digest 用于漂移检测，不构成来源
  真实性签名。
- 正式更新创建新目录，不能覆写旧 release。在途 worker 不会读到半更新产物。

## 跨模块交互

UI 读取公共工具元数据和已有结果。questions、background-shell、subagents 的
工具 renderer 及 `subagent-result` 消息 renderer 保持专用展示；第三方
Agent/StopAgent 的专用 renderer 同样保持优先，不因属于私有包而被接管。
footer 消费宿主提供的 extension statuses，不清理其他模块的状态键。

后台通知、`.pi/tasks` 元数据和补丁报告由对应能力维护，UI 不改写格式。
deferred questions/background 工具仍通过内置 `tool_search` 发现；
`defaultTools: ["+tool_search"]` 是用户选择，不由安装脚本隐式重写。
tools 模块以同名扩展覆盖内置 `grep`/`find`/`ls`，exposure 为 `codemode`：
默认不直接声明给模型，启用内置 `codemode` 后由脚本调用，显式激活仍然有效。
CLI 加载内置 codemode/tool_search 扩展，但默认不激活这些工具；SDK 会话
不自动加载它们，嵌入宿主需通过 `DefaultResourceLoader.extensionFactories`
显式提供 `createCodemodeExtension()` / `createToolSearchExtension()`。

## 子会话边界

subagents 使用进程内 SDK 为每个子代理创建独立 `AgentSession`，以目标 cwd、
agentDir 和可信状态创建同一 `SettingsManager`，共同驱动资源 loader 与会话。
不可信目标不加载受保护的项目配置/扩展/skills/MCP；用户级配置仍生效。
AGENTS.md 按宿主 context 合同处理，不把项目可信状态等同于完全隔绝所有文本。

子会话显式提供 Pi 的 `createCodemodeExtension()`、`createToolSearchExtension()`、
`createMcpExtension()`，身份分别是 `builtin:codemode`、`builtin:tool-search`、
`builtin:mcp`。PackageManager 先发现已启用的候选，模块在工厂执行前选择；
loader 不再隐式加载其他候选，宿主禁用和 replaceable 语义仍然有效。
无显式配置的 general-purpose 默认只选择这三原生扩展，而非全包入口。

工具准入与 active 展示分开：继承模式不向 SDK 传静态 registry 快照；exact
allow/exclude 限制作用于注册与直接/嵌套调用。`Agent` 系列始终排除于子会话，
跨编译实例的 AsyncLocalStorage 子调用标记另行避免递归注册。
MCP 延迟工具由宿主处理，搜索激活与 codemode store 只保留在该子会话内。
每个子会话拥有自己的 MCP 连接，不共享父/其他子会话的客户端或工具闭包。

普通完成和 Stop 保留 session，允许 continuation；widget 行过期只隐藏展示，
不释放连接。Clear 或父 reload/quit/new/resume/fork 关闭其所有权：发出 abort、
等待初始化边界、发 `session_shutdown`、dispose 并解除引用；关闭入口幂等且可等待，
不因无限等待模型 idle 而阻塞清理。运行并发上限不限制 retained session/MCP
进程总数，长会话需要显式 Clear。详见[模块契约](../extensions/pi-subagents/README.md)。

## 文档职责

根 README 负责定位、入口索引和安全边界；本文负责跨模块职责与依赖/产物结构；
`development.md` 负责构建、测试、隔离和发布流程；模块 README 与
`LICENSE`/`UPSTREAM.md` 负责单能力用法及继承代码的来源与许可。
