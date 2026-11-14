# pi-Serraly

自用的 Pi 扩展源码工作区：Bun workspaces，**Pi 1.5.2 / Node ≥22.19 / Bun 1.4.2**，不发布 npm。

## 扩展

| 包 | 职责 |
| --- | --- |
| [pi-codex-conversion](packages/pi-codex-conversion/README.md) | Codex provider、工具执行、Code/Notebook、默认工具卡 |
| [pi-ask](packages/pi-ask/README.md) | 交互式提问、steer/handoff/review |
| [pi-codex-imagegen](packages/pi-codex-imagegen/README.md) | 图像生成与编辑 |
| [pi-codex-guardian](packages/pi-codex-guardian/README.md) | 复用 Codex 默认审批政策，自动审核工具调用；支持原生/网关连接与可选拦截规则 |
| [pi-shepherdr](packages/pi-shepherdr/README.md) | Herdr 多代理编排 |
| [pi-agent-board](packages/pi-agent-board/README.md) | 独立可选的共享任务板与查看器 |
| [pi-auto-trees](packages/pi-auto-trees/README.md) | 会话 marker、prime 与 end |
| [pi-notes-compaction](packages/pi-notes-compaction/README.md) | 独立可选的 Notes、历史检索与共享上下文；使用 SQLite 原生模块 |
| [pi-suggestions](packages/pi-suggestions/README.md) | 空输入框中的下一步请求草稿；独立模型，默认关闭 |
| [pi-github-watch](packages/pi-github-watch/README.md) | 按需监控 GitHub Issue、PR 反馈和 Actions 运行，通知当前会话 |
| [pi-ui](packages/pi-ui/README.md) | Thinking、Footer、活动完成提示和置顶用户消息；不接管工具渲染 |
| [pi-session-recap](packages/pi-session-recap/README.md) | TUI 的 `/recap` 与默认开启的空闲任务摘要；临时展示，不写入模型上下文 |

默认逐包注册，只启用需要的包。可选的 [pi-extensions](packages/pi-extensions/README.md) 一次登记上述全部十二个扩展的独立入口，可在 `pi config` 中分别开关；不要与其中成员重复登记。context-view 从其独立上游安装。

Notes/History 由独立 Notes 包提供，不内置于 conversion。需要时单独登记 Notes，或启用整合包中的 Notes 入口；旧 Notes 设置不会被静默关闭，缺少新扩展时会提示迁移。详见 [Notes README](packages/pi-notes-compaction/README.md)。

Shepherdr 需要 Herdr Core ≥0.1.21，不再支持旧 Herdr TUI 后端；Notes 与 Board 都是可选集成。本仓保留这两个独立包，不引入上游的 Agent Comms 合包。详见 [Shepherdr README](packages/pi-shepherdr/README.md)。

## 开发与部署

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build -- --package pi-codex-conversion
bun run check -- --package pi-codex-conversion
bun run test -- --package pi-codex-conversion
```

开发仓库与安装工作区分开。安装工作区保留完整仓库文件但不含 `.git`，默认放在 `~/.pi/pi-Serraly`：用 Bun 准备依赖和产物，再用原生 Pi 命令逐包登记，例如 `pi install ~/.pi/pi-Serraly/packages/pi-codex-conversion`，或统一登记 `pi-extensions`。所有扩展共用这一工作区，不另复制仓库。本地路径原地加载；Pi 不复制、不构建、不安装其依赖。根目录不注册扩展，安装全部依赖也不会自动启用所有包。

安装工作区整体更新，不在安装目录执行 Git 操作；历史保留在开发仓库。已登记的包在下一次完整启动时加载更新。依赖准备、设置变更、更新及回滚步骤见 [development](docs/development.md#本地安装工作区)。

跨包或构建、安装、release 工具修改使用 `npm run verify`。`bun run release -- --output /absolute/path/to/new-release` 保留为可选的离线整仓快照，不是日常安装的前置步骤。

自动验证在隔离环境中离线运行。真实登录、模型及外部服务验收须另行授权，见 [测试与隔离](docs/development.md#测试与隔离)。

## 维护导航

- [架构与依赖](docs/architecture.md)
- [命令、隔离、发布与手动更新](docs/development.md)
- [来源索引](UPSTREAM.md)与各包 UPSTREAM、README、LICENSE

旧扩展、共享库与旧构建发布框架不参与当前运行或维护；历史保留在 Git 中。
