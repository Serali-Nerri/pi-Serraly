# 仓库架构

## 源码与职责

`packages/*` 包含七个保留的 howaboua-pi-stuff 功能包和独立的 pi-ui。前七包保留上游包名、源码组织和公开导出；根目录协调开发与本地交付，不再次注册能力。

| 包 | 拥有 | 依赖边界 |
| --- | --- | --- |
| pi-codex-conversion | provider、工具定义/执行、真实 trace、Notebook、默认工具卡、资源清理 | Pi host 与自身运行依赖 |
| pi-ask | 问卷与交互状态 | 可选接入 conversion 公共协议 |
| pi-browser | 浏览器工具、连接与 worker 生命周期 | 可选接入 conversion 公共协议 |
| pi-codex-imagegen | 图像请求、产物与工具 | 可选接入 conversion 公共协议 |
| pi-shepherdr | Herdr fleet、agent 工具、profiles 与共享上下文 | 硬依赖 pi-agent-board；可选接入 conversion |
| pi-agent-board | 任务板、运行时与 Web 查看器 | 可选接入 conversion 公共协议 |
| pi-auto-trees | marker/prime/end 会话流程 | 可选接入 conversion 公共协议 |
| pi-ui | Thinking、Footer、活动完成提示、置顶用户消息、展示设置与清理 | 只依赖 Pi host，不接管工具或执行 |

跨包依赖使用公开导出，不读取兄弟私有源码。宿主包是 peer，不随正式运行树安装；开发使用精确 Pi 1.4.0。外部运行依赖正常安装，不再要求无 dependencies 或全部 bundle。

## 工具卡

conversion 保留上游默认渲染、预览规则、工具命名和 Display 设置，使用宿主 pending/success/error 背景与 padding。唯一的展示扩展是脚本、脚本输出和每次补丁的独立点击展开/折叠。Ctrl+O 沿用宿主全局控制，切换时清除局部选择；重绘、流式更新和主题变化不清除选择。补丁沿用原 renderer 和执行前缓存。

渲染组件不得捕获完整宿主 context 或串联 lastComponent；状态只保留展开选择和当前 invalidate 回调，已离开 trace 列表的补丁选择及时清理。普通调用继续使用各工具的原始调用与结果渲染。局部点击不改变执行、trace、输出保留或历史 diff 的能力。细则由 conversion README 持有。

## 界面

pi-ui 仅在交互 TUI 安装展示。Footer 使用公开 setFooter 与事件增量维护会话用量；Git 分支沿用宿主 provider。Thinking 和 fullscreen 置顶消息没有公开 renderer 注册入口，包内隔离 Pi 1.4 的最小兼容适配：只装饰原生 Thinking 子组件，以及合成置顶行与点击定位；能力缺失时单项告警、其余功能继续。退出、reload 和会话替换撤销适配。

Thinking 以连续 reasoning run 为粒度，支持标题、尾部预览、局部点击、宿主 Ctrl+T、耗时与分支历史恢复。持久化只写非模型上下文的耗时元数据。活动完成提示使用公开 entry renderer，在 agent_settled 后追加一次非模型上下文的净工作耗时和结束时刻；不改写回复，不新增计时器或历史索引。Footer 不在 render 或动画 tick 遍历历史；历史只在启动/分支切换/压缩后重建。活动动画只请求宿主重绘，不读取会话历史或重新构建消息。

组件不保留完整事件/渲染 context 或 lastComponent 链。布局缓存、展开选择和耗时索引有界，计时器、订阅及兼容适配均有幂等清理。配置的读取、校验和原子写入属于 pi-ui 内部，不恢复旧共享库。没有旧工具分组、消息摘要或 Markdown 改写。细则由 pi-ui README 持有。

## 资源与构建

- conversion 保留原生工具源码/随附二进制、WASM、tokenizer、vendor、Code runtime 资源和许可。
- browser 构建 dist 和远端 worker；agent-board 构建查看器及 Web 静态文件。
- ask、imagegen、Shepherdr、auto-trees 使用 Pi 支持的 TS 入口；prompts、profiles、远端脚本及包内资源跟随交付。
- pi-ui 将包内模块合为已去除类型的 `dist/index.ts` 单入口，Pi host imports 保持 external，避免原生 JS 加载绕过实际宿主组件绑定；保留包许可与来源，不导入旧 pi-ui 工具渲染及框架。
- conversion 的 `examples/custom-tools/browser/cdp-lib` 是本仓维护源，不再同步未迁入的 skill 包。
- 不迁入上游个人 AGENTS/.pi、聚合包、Changesets 发布系统或无关跨包原生工作流。

build 只生成产物；check/test 不隐式构建；verify 构建一次后检查、测试。release 只消费现有产物和锁定缓存，不重新构建或联网。

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

本地 release 版本来自根 package.json；包版本保留上游基线。release.json 记录版本与成员身份，不是来源真实性签名。真实设置切换不属于 release 命令。

## 文档边界

README 索引入口；本文定义职责与产物；development 定义操作；各包 README/许可定义使用与条款，各包 UPSTREAM 定义固定来源和当前差异；根 UPSTREAM 只做索引。
