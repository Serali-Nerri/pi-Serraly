# 仓库架构

## 源码与职责

`packages/*` 是七个 Pi 功能包，保留 howaboua-pi-stuff 包名、源码组织和公开导出；根目录协调开发与本地交付，不再次注册能力。

| 包 | 拥有 | 依赖边界 |
| --- | --- | --- |
| pi-codex-conversion | provider、工具定义/执行、真实 trace、Notebook、默认工具卡、资源清理 | Pi host 与自身运行依赖 |
| pi-ask | 问卷与交互状态 | 可选接入 conversion 公共协议 |
| pi-browser | 浏览器工具、连接与 worker 生命周期 | 可选接入 conversion 公共协议 |
| pi-codex-imagegen | 图像请求、产物与工具 | 可选接入 conversion 公共协议 |
| pi-shepherdr | Herdr fleet、agent 工具、profiles 与共享上下文 | 硬依赖 pi-agent-board；可选接入 conversion |
| pi-agent-board | 任务板、运行时与 Web 查看器 | 可选接入 conversion 公共协议 |
| pi-auto-trees | marker/prime/end 会话流程 | 可选接入 conversion 公共协议 |

跨包依赖使用公开导出，不读取兄弟私有源码。宿主包是 peer，不随正式运行树安装；开发使用精确 Pi 1.4.0。外部运行依赖正常安装，不再要求无 dependencies 或全部 bundle。

## 工具卡

conversion 自有默认工具卡，使用宿主 pending/success/error 背景与 padding。保留脚本前 10 个视觉行、最近 8 个普通内部调用、每调用输入 80 个 Unicode 字符、完成输出前 5 个视觉行，以及脚本/输出/补丁各自点击与 Ctrl+O。补丁沿用原 renderer 和执行前缓存。

渲染组件不得捕获完整宿主 context 或串联 lastComponent；状态只保留展开选择和当前 invalidate 回调。普通调用不展开原始内部结果。错误、重要通知与生产端截断不可被预览开关吞掉。细则由 conversion README 持有。

没有 pi-ui、旧工具分组、Thinking/footer 私有兼容框架或旧共享库；未来 UI 另行设计。

## 资源与构建

- conversion 保留原生工具源码/随附二进制、WASM、tokenizer、vendor、Code runtime 资源和许可。
- browser 构建 dist 和远端 worker；agent-board 构建查看器及 Web 静态文件。
- ask、imagegen、Shepherdr、auto-trees 使用 Pi 支持的 TS 入口；prompts、profiles、远端脚本及包内资源跟随交付。
- conversion 的 `examples/custom-tools/browser/cdp-lib` 是本仓维护源，不再同步未迁入的 skill 包。
- 不迁入上游个人 AGENTS/.pi、聚合包、Changesets 发布系统或无关跨包原生工作流。

build 只生成产物；check/test 不隐式构建；verify 构建一次后检查、测试。release 只消费现有产物和锁定缓存，不重新构建或联网。

## 固定版本运行树

```text
<release>/
  package.json
  bun.lock
  release.json
  packages/<七包>/       清单允许的源码、dist、许可与资源
  node_modules/          运行依赖及树内 workspace 链接
```

根 manifest 不注册扩展，安装时选择各包路径。运行依赖以及指向已交付成员的 peer 导入保留树内链接，包括可选的 conversion 集成；可导入不等于自动启用。release 不含物理 Pi host、开发工具或指向开发树的链接。目标必须是开发树之外的新绝对路径，完整组装校验后才发布，不覆写正在使用的版本。

本地 release 版本来自根 package.json；包版本保留上游基线。release.json 记录版本与成员身份，不是来源真实性签名。真实设置切换不属于 release 命令。

## 文档边界

README 索引入口；本文定义职责与产物；development 定义操作；各包 README/许可定义使用与条款，各包 UPSTREAM 定义固定来源和当前差异；根 UPSTREAM 只做索引。
