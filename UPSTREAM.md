# 上游来源索引

仓库保留的十个 Howaboua 包来自
[IgorWarzocha/howaboua-pi-stuff](https://github.com/IgorWarzocha/howaboua-pi-stuff)。本轮同步将上游基线推进到
`19ec6357fa3c4eb0126f8b0d4b6569de1a655ef9`，并将根工程与宿主依赖统一到 Pi `1.6.0`。
各包的 UPSTREAM 文档记录仍然存在的本地适配；Notes 仍为独立可选扩展。

| 包 | 当前基线版本 | 来源与当前差异 |
| --- | --- | --- |
| pi-codex-conversion | 5.0.2 | [UPSTREAM](packages/pi-codex-conversion/UPSTREAM.md) |
| pi-ask | 0.0.21 | [UPSTREAM](packages/pi-ask/UPSTREAM.md) |
| pi-codex-imagegen | 0.0.16 | [UPSTREAM](packages/pi-codex-imagegen/UPSTREAM.md) |
| pi-codex-guardian | 0.0.1 | [UPSTREAM](packages/pi-codex-guardian/UPSTREAM.md) |
| pi-shepherdr | 1.0.3 | [UPSTREAM](packages/pi-shepherdr/UPSTREAM.md) |
| pi-agent-board | 0.0.9 | [UPSTREAM](packages/pi-agent-board/UPSTREAM.md) |
| pi-auto-trees | 0.1.19 | [UPSTREAM](packages/pi-auto-trees/UPSTREAM.md) |
| pi-notes-compaction | 0.0.19 | [UPSTREAM](packages/pi-notes-compaction/UPSTREAM.md) |
| pi-suggestions | 0.0.4 | [UPSTREAM](packages/pi-suggestions/UPSTREAM.md) |
| pi-github-watch | 0.0.8 | [UPSTREAM](packages/pi-github-watch/UPSTREAM.md) |

上游当前主线已移除 `pi-auto-trees`；本仓保留它作为本地独立包，未伪装成当前主线成员。Guardian 没有新的运行时版本，本轮只更新其 Pi/PCC 宿主约束。

保留各包 LICENSE、NOTICE、vendor 和嵌套来源；MIT 包许可不替代所含 Apache-2.0 等第三方条款。conversion 卡片来源与 MIT 文本在包内 CARD-LICENSE.md。根工程不将继承代码重新授权为统一自有许可。

根目录 `.oxfmtrc.json`、`.oxlintrc.json` 改编自上游同步基线，按本仓包范围调整；对应上游 MIT 原文完整保存在 [LICENSE](packages/pi-codex-conversion/LICENSE)。

独立的 [pi-ui](packages/pi-ui/UPSTREAM.md) 从本仓精简 UI 分支抽取 Thinking/Footer/活动完成提示/置顶消息的最小展示契约，并适配 pi-open-tui 的 Git Footer 段；保留相关 MIT 来源与许可，不属于上述十包上游。

[pi-extensions](packages/pi-extensions/UPSTREAM.md) 是本仓可选整合包，包含上述十包、pi-ui 和 pi-session-recap，参照早期上游的包依赖模式，使用可独立开关的多个转发入口；成员清单和版本由本仓维护。

[pi-session-recap](packages/pi-session-recap/UPSTREAM.md) 是独立扩展，提示词与历史选择参考 OpenAI Codex 的固定提交 `69231e119bfca0b14453515e97d99688ce1c47c9`，包内保留 Apache-2.0 来源与条款；其余原创实现使用 MIT。

不保留上游个人 AGENTS/.pi 和全仓发布系统。包原始 CHANGELOG 记录上游历史，本仓当前差异由各包 UPSTREAM 持有；更新步骤见 [development](docs/development.md#手动同步上游)。
