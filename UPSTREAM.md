# 上游与许可汇总

以下扩展保留了外部上游代码；固定来源、变更记录与许可文本由模块内的
`UPSTREAM.md` 和 `LICENSE`/`licenses/` 持有，本文件只做汇总与索引。

| 扩展 | 上游 | 固定来源 | 许可 |
| --- | --- | --- | --- |
| [`pi-ui`](extensions/pi-ui/README.md) | minuque/pi-cc-extensions、tifandotme/pi-extensions、OldSuns/pi-open-tui、MarkedJS | 见下 | MIT（按来源分别保留） |
| [`pi-background-shell`](extensions/pi-background-shell/README.md) | [ismailsaleekh/pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks) | `471f1dcae7ff13d8f989e4c056bdff1e6b01f1ef`；npm `pi-background-tasks@2.6.8` | ISC |
| [`pi-add-dir`](extensions/pi-add-dir/README.md) | [HenryQW/pi-harness](https://github.com/HenryQW/pi-harness) | `4d9ed14b8016abcecb3d97af8c28ca37a3ca265f` | MIT |
| [`pi-subagents`](extensions/pi-subagents/README.md) | [AlexParamonov/pi-subagents-lite](https://github.com/AlexParamonov/pi-subagents-lite) | v1.15.1，`0a9ad2f14562daeec2b5d815fbdf42695f2e7f11` | MIT |

模块内记录（含完整变更清单与固定来源）：

- `pi-ui`：[licenses/README.md](extensions/pi-ui/licenses/README.md)
- `pi-background-shell`：[UPSTREAM.md](extensions/pi-background-shell/UPSTREAM.md)
- `pi-add-dir`：[UPSTREAM.md](extensions/pi-add-dir/UPSTREAM.md)
- `pi-subagents`：[UPSTREAM.md](extensions/pi-subagents/UPSTREAM.md)

## pi-ui

`pi-ui` 组合多个独立许可的来源，版权与许可文本逐项保留在
[`extensions/pi-ui/licenses/`](extensions/pi-ui/licenses/README.md)：

- `minuque/pi-cc-extensions` v0.8.69（`5d7a2666f51da9f450bd019af10200c88cc1df98`）
  与 v0.8.70（`26aa98df430fa4112c6880367b9d477c0ef53f1f`）的渲染、thinking、
  context、Markdown 和工具摘要模块；
- `tifandotme/pi-extensions` 的 `pi-compact-thinking`；
- `OldSuns/pi-open-tui` 0.3.1 的 footer 渲染、icons、运行时检测、usage 聚合与
  格式化，记录在
  [`licenses/pi-session-ui-UPSTREAM.md`](extensions/pi-ui/licenses/pi-session-ui-UPSTREAM.md)；
- MarkedJS / Christopher Jeffrey / John Gruber 的 reference-definition grammar。

## 共享库

`pi-ui-kit` 的工具卡渲染改自 pi-cc-extensions，许可通知随库复制；`pi-config-core`
与 `pi-apply-patch-protocol` 为自有代码。详见各包的 `UPSTREAM.md`。
