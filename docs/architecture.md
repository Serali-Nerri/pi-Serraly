# 仓库架构

## 源码与职责

`packages/*` 包含八个保留的 howaboua-pi-stuff 功能包、独立的 pi-ui 与 pi-session-recap，以及可选的 pi-extensions 整合包。八包保留上游包名、源码组织和公开导出；根目录协调开发与构建，不再次注册能力。

| 包 | 拥有 | 依赖边界 |
| --- | --- | --- |
| pi-codex-conversion | provider、工具定义/执行、真实 trace、Notebook、默认工具卡、资源清理 | Pi host 与自身运行依赖 |
| pi-ask | 问卷与交互状态 | 可选接入 conversion 公共协议 |
| pi-codex-imagegen | 图像请求、产物与工具 | 可选接入 conversion 公共协议 |
| pi-shepherdr | Herdr Core fleet、agent 工具、profiles 与共享上下文 | Herdr Core；可选接入 conversion、Notes 与 Board |
| pi-agent-board | 任务板、运行时与 Web 查看器 | 可选接入 conversion 公共协议 |
| pi-auto-trees | marker/prime/end 会话流程 | 可选接入 conversion 公共协议 |
| pi-notes-compaction | Notes、历史检索、上下文窗口、共享上下文与显式会话裁剪 | better-sqlite3；可选接入 conversion 公共协议 |
| pi-suggestions | 下一步用户请求草稿、空编辑器展示与预测请求清理 | 只依赖 Pi host；可选接入 Notes 窗口投影和 Shepherdr worker 识别 |
| pi-ui | Thinking、Footer、活动完成提示、置顶用户消息、展示设置与清理 | 只依赖 Pi host，不接管工具或执行 |
| pi-session-recap | TUI 手动/空闲 recap、历史裁剪、临时卡片与请求清理 | 只依赖公开 Pi host API；模型注册表发起独立摘要请求 |
| pi-extensions | 显式组合仓库全部十个扩展的注册入口 | workspace 运行依赖；调用成员公开导出 |

跨包依赖使用公开导出，不读取兄弟私有源码。宿主包是 peer，不随正式运行树安装；开发使用精确 Pi 1.5.2。工具 schema 使用 Pi 原生 schema 包，外部运行依赖由 workspace 安装。

pi-extensions 显式维护成员依赖和 manifest 入口顺序。十个成员各有一个 TS 转发入口，默认全部启用，可由 `pi config` 分别开关。更新提示的边界见 [整合包 README](../packages/pi-extensions/README.md)。默认仍逐包登记，整合包不能与其成员重复加载。

Notes 独占 Notes/History 与共享上下文，公开 `@howaboua/pi-notes-compaction/context-sharing`；conversion 改为公开 `./compaction` 和 `./agent-relationship`，不再导出旧 `./context-sharing`。Notes 使用 conversion 的压缩协议；Shepherdr 分别接入 Notes 的共享上下文和 conversion 的代理关系。依赖存在不会自动加载 Notes；旧 PCC Notes 配置在未加载新拥有者时阻止运行并提示迁移，不静默改写设置。

## 工具卡

conversion 保留上游默认渲染、预览规则、工具命名和 Display 设置，使用宿主 pending/success/error 背景与 padding。脚本、脚本输出和每次嵌套调用独立点击展开/折叠，包括同名重复调用。Ctrl+O 沿用宿主全局控制，切换时清除局部选择；重绘、流式更新和主题变化不清除选择。补丁沿用原 renderer 和执行前缓存。

渲染组件不得捕获完整宿主 context 或串联 lastComponent；状态只保留展开选择和当前 invalidate 回调，完整 trace 快照中已离开的调用选择及时清理。普通调用继续使用各工具的原始调用与结果渲染；嵌套 view_image 只显示标题、路径和错误，显式脚本 image(...) 的图片由宿主展示。局部点击不改变执行、trace、输出保留或历史 diff 的能力。细则由 conversion README 持有。

## 界面

pi-ui 仅在交互 TUI 安装展示。Footer 使用公开 setFooter 与事件增量维护会话用量；[Git 状态](../packages/pi-ui/README.md#git-状态) 按事件异步读取本地仓库，render 只读快照。Thinking 和 fullscreen 置顶消息没有公开 renderer 注册入口，包内隔离最小兼容适配：只装饰原生 Thinking 子组件，以及合成置顶行与点击定位；能力缺失时单项告警、其余功能继续。退出、reload 和会话替换撤销适配。

Thinking 以连续 reasoning run 为粒度，支持标题、尾部预览、局部点击、宿主 Ctrl+T、耗时与分支历史恢复。持久化只写非模型上下文的耗时元数据。活动完成提示使用公开 entry renderer，在 agent_settled 后追加一次非模型上下文的净工作耗时和结束时刻；不改写回复，不新增计时器或历史索引。Footer 按事件刷新，不启动活动计时器；render 不遍历历史，历史只在启动/分支切换/压缩后重建。Thinking 动画只请求宿主重绘，不读取会话历史或重新构建消息。

组件不保留完整事件/渲染 context 或 lastComponent 链。布局缓存、展开选择和耗时索引有界，计时器、订阅及兼容适配均有幂等清理。配置的读取、校验和原子写入属于 pi-ui 内部，不恢复旧共享库。没有旧工具分组、消息摘要或 Markdown 改写。细则由 pi-ui README 持有。

## 资源与构建

- pi-session-recap 使用 TS 入口；默认自动摘要在 settled 后空闲 30 分钟、3 个已完成用户 exchange 且距上次摘要新增 2 个 exchange 时请求模型。只展示临时 widget，不持久化 recap、不进入上下文；可独立配置摘要模型和关闭自动请求，详见包 README。许可随包交付。
- conversion 保留原生工具源码/随附二进制、WASM、tokenizer、vendor、Code runtime 资源和许可。
- conversion 的 TS/JS Notebook 与 Deno Code 按需准备各自运行时；普通启动不要求提前下载全部可选运行时。
- Notes 保留 TS 入口、历史检索 worker 与许可；better-sqlite3 随 npm 包提供平台预构建原生模块，开发、生产安装和离线快照均须验证数据库可加载。会话裁剪默认关闭，只由用户显式启用。
- Suggestions 使用 TS 入口；Markdown 默认指令和原生 ESM 会话资源清理模块随包交付。预测默认关闭，配置见包 README。
- agent-board 构建查看器及 Web 静态文件。
- ask、imagegen、Shepherdr、auto-trees 使用 Pi 支持的 TS 入口；prompts、profiles、远端脚本及包内资源跟随交付。
- pi-ui 将包内模块合为已去除类型的 `dist/index.ts` 单入口，Pi host imports 保持 external，避免原生 JS 加载绕过实际宿主组件绑定；公开类型由 `types/index.d.ts` 提供，避免消费者检查类型已擦除的运行产物。保留包许可与来源，不导入旧 pi-ui 工具渲染及框架。
- conversion 保留上游 legacy command-backed CDP custom-tool 示例，默认不启用；用法见 [示例 README](../packages/pi-codex-conversion/examples/custom-tools/browser/README.md)。
- pi-extensions 使用 TS 入口与成员公开包入口；成员自己的资源仍由成员包拥有。
- 不迁入上游个人 AGENTS/.pi、Changesets 发布系统、整合包自动生成流程或无关跨包原生工作流。

build 只生成产物，支持按包及其 workspace 构建依赖选择；check/test 不隐式构建，test 支持包对应的定向集成测试；verify 构建一次后检查、测试。release 只消费现有产物和锁定缓存，不重新构建或联网。

## 完整安装工作区

```text
~/.pi/pi-Serraly/
  package.json
  bun.lock
  scripts/、docs/、test/  完整仓库源码
  packages/             全部独立包与可选整合包
  node_modules/         Bun workspace 依赖
```

安装工作区独立于开发树，保留完整仓库文件但不含 `.git`；Git 历史只保留在开发仓库。所有包共用这一工作区，包括独立登记的 pi-ui 和 pi-session-recap。依赖安装和构建通过普通 Bun workspace 命令完成，登记、资源过滤、加载与移除属于原生 Pi。生产依赖树不携带物理宿主包；准备和整仓更新命令由 development 持有。

所有成员存在并可导入，不代表被启用。默认逐包 pi install；Shepherdr 不会自动登记 Notes 或 Board 入口。根 manifest 不注册资源。可选整合包只有被显式登记才提供全部十个扩展的入口，成员的加载由 Pi 资源开关控制。

更新整个工作区可能同时改变多个已登记包，下次完整启动统一加载。备份与回滚以完整安装工作区和必要的 settings 为单位；安装目录不负责保存 Git 历史。

## 固定版本运行树

```text
<release>/
  package.json
  bun.lock
  release.json
  packages/<包名>/       清单允许的源码、dist、许可与资源
  node_modules/          运行依赖及树内 workspace 链接
```

根 manifest 不注册扩展，安装时选择各包路径。运行依赖以及指向已交付成员的 peer 导入保留树内链接，包括可选的 conversion 集成；可导入不等于自动启用。release 不含物理 Pi host、开发工具或指向开发树的链接。目标必须是开发树之外的新绝对路径，完整组装校验后才发布，不覆写正在使用的版本。

整仓 release 是可选快照。本地 release 版本来自根 package.json；各包版本保留各自上游基线，本地差异由 Git 和包内本地 changelog 标识。release.json 记录根版本与成员身份，真实设置切换不属于 release 命令。

## 文档边界

README 索引入口；本文定义职责与产物；development 定义操作；各包 README/许可定义使用与条款，各包 UPSTREAM 定义固定来源和当前差异；根 UPSTREAM 只做索引。
