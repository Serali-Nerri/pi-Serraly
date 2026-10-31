# 上游来源索引

八包来自 [IgorWarzocha/howaboua-pi-stuff](https://github.com/IgorWarzocha/howaboua-pi-stuff)，固定提交 `e4aa5bb43c560b722829a5123b3f2e05d3d9a19d`。从旧基线 `d67cb69b22decc4ea024236ba59dc4ddae9a2334` 三方合并，保留本地工具公告分组、局部点击展开、图片显示所有权、工具默认禁用和离线启动；Notes 仍为独立可选扩展。

| 包 | 基线版本 | 来源与当前差异 |
| --- | --- | --- |
| pi-codex-conversion | 4.0.7 | [UPSTREAM](packages/pi-codex-conversion/UPSTREAM.md) |
| pi-ask | 0.0.17 | [UPSTREAM](packages/pi-ask/UPSTREAM.md) |
| pi-browser | 0.0.13 | [UPSTREAM](packages/pi-browser/UPSTREAM.md) |
| pi-codex-imagegen | 0.0.12 | [UPSTREAM](packages/pi-codex-imagegen/UPSTREAM.md) |
| pi-shepherdr | 0.2.25 | [UPSTREAM](packages/pi-shepherdr/UPSTREAM.md) |
| pi-agent-board | 0.0.4 | [UPSTREAM](packages/pi-agent-board/UPSTREAM.md) |
| pi-auto-trees | 0.1.19 | [UPSTREAM](packages/pi-auto-trees/UPSTREAM.md) |
| pi-notes-compaction | 0.0.13 | [UPSTREAM](packages/pi-notes-compaction/UPSTREAM.md) |

保留各包 LICENSE、NOTICE、vendor 和嵌套来源；MIT 包许可不替代所含 Apache-2.0 等第三方条款。conversion 卡片来源与 MIT 文本在包内 CARD-LICENSE.md。根工程不将继承代码重新授权为统一自有许可。

独立的 [pi-ui](packages/pi-ui/UPSTREAM.md) 从本仓精简 UI 分支抽取 Thinking/Footer/活动完成提示/置顶消息的最小展示契约，保留相关 MIT 来源与许可，不属于上述八包上游。

[pi-extensions](packages/pi-extensions/UPSTREAM.md) 是本仓可选整合包，包含上述八包、pi-ui 和 pi-session-recap，参照早期上游的包依赖模式，使用可独立开关的多个转发入口；成员清单和版本由本仓维护。

[pi-session-recap](packages/pi-session-recap/UPSTREAM.md) 是独立扩展，提示词与历史选择参考 OpenAI Codex 的固定提交 `970111f6cb62cc02fe36a82ea7d71b37a2889c97`，包内保留 Apache-2.0 来源与条款；其余原创实现使用 MIT。

不保留上游个人 AGENTS/.pi 和全仓发布系统。包原始 CHANGELOG 记录上游历史，本仓当前差异由各包 UPSTREAM 持有；更新步骤见 [development](docs/development.md#手动同步上游)。
