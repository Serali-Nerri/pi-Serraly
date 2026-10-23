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

每包独立注册，只启用需要的包，不使用上游聚合包。context-view 从其独立上游安装；本仓库不包含 pi-ui。

## 开发与部署

```sh
bun install --frozen-lockfile --ignore-scripts
npm run verify
bun run release -- --output /absolute/path/to/new-release
```

release 离线消费已构建产物和本地依赖缓存，拒绝覆盖已有目录，不安装到 Pi、不修改设置。正式启用时逐包引用不可变 release 中的 `packages/<包名>`，不要安装开发根目录。

验证使用临时 HOME/config/session、合成夹具和网络拒绝，不读取真实凭据、不发送模型请求。浏览器、Herdr、Codex 登录等外部集成仍需另行授权验收。

## 维护导航

- [架构与依赖](docs/architecture.md)
- [命令、隔离、发布与手动更新](docs/development.md)
- [来源索引](UPSTREAM.md)与各包 UPSTREAM、README、LICENSE

旧扩展、共享库与旧构建发布框架不参与当前运行或维护；历史保留在 Git 中。
