# pi-Serraly

自用的 Pi 扩展源码工作区：Bun workspaces，**Pi 1.4.0 / Node ≥22.19 / Bun 1.4.2**，不发布 npm。

## 扩展

| 包 | 职责 |
| --- | --- |
| [pi-codex-conversion](packages/pi-codex-conversion/README.md) | Codex provider、工具执行、Code/Notebook、默认工具卡 |
| [pi-ask](packages/pi-ask/README.md) | 交互式提问、steer/handoff/review |
| [pi-browser](packages/pi-browser/README.md) | 浏览器工具与托管 worker |
| [pi-codex-imagegen](packages/pi-codex-imagegen/README.md) | 图像生成与编辑 |
| [pi-shepherdr](packages/pi-shepherdr/README.md) | Herdr 多代理编排 |
| [pi-agent-board](packages/pi-agent-board/README.md) | 共享任务板与查看器；Shepherdr 的运行依赖 |
| [pi-auto-trees](packages/pi-auto-trees/README.md) | 会话 marker、prime 与 end |
| [pi-ui](packages/pi-ui/README.md) | Thinking、Footer、活动完成提示和置顶用户消息；不接管工具渲染 |

默认逐包注册，只启用需要的包。可选的 [pi-extensions](packages/pi-extensions/README.md) 一次登记前七包的独立入口，可在 `pi config` 中分别开关，不包含 pi-ui；不要与其中成员重复登记。context-view 从其独立上游安装。

## 开发与部署

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build -- --package pi-codex-conversion
bun run check -- --package pi-codex-conversion
bun run test -- --package pi-codex-conversion
```

开发目录与安装 checkout 分开。安装 checkout 是完整仓库，默认放在 `~/.pi/pi-Serraly`：用 Bun 准备依赖和产物，再用原生 Pi 命令逐包登记，例如 `pi install ~/.pi/pi-Serraly/packages/pi-codex-conversion`。本地路径原地加载；Pi 不复制、不构建、不安装其依赖。根目录不注册扩展，安装全部依赖也不会自动启用所有包。

安装 checkout 作为一个 workspace 更新，已登记的包在下一次完整启动时加载更新。依赖准备、设置变更、更新及回滚步骤见 [development](docs/development.md#本地安装-checkout)。

跨包或构建、安装、release 工具修改使用 `npm run verify`。`bun run release -- --output /absolute/path/to/new-release` 保留为可选的离线整仓快照，不是日常安装的前置步骤。

自动验证在隔离环境中离线运行。真实登录、模型及外部服务验收须另行授权，见 [测试与隔离](docs/development.md#测试与隔离)。

## 维护导航

- [架构与依赖](docs/architecture.md)
- [命令、隔离、发布与手动更新](docs/development.md)
- [来源索引](UPSTREAM.md)与各包 UPSTREAM、README、LICENSE

旧扩展、共享库与旧构建发布框架不参与当前运行或维护；历史保留在 Git 中。
