# 上游与许可汇总

以下扩展保留了外部上游代码；固定来源、变更记录与许可文本由模块内的
`UPSTREAM.md` 和 `LICENSE`/`licenses/` 持有，本文件只做汇总与索引。

| 扩展 | 上游 | 固定来源 | 许可 |
| --- | --- | --- | --- |
| [`context-view`](extensions/context-view/README.md) | [dimk90/pi-context-view](https://github.com/dimk90/pi-context-view) | 0.6.0，`0eb5f9773c91b63b873da4d9ca6fa6caf795e91a`（非 v0.6.0 标签提交）；选择性吸收 v0.7.1，`cc988b63d45cf82a6397a81c79739c3684f6a9c7` | MIT / Dmitry Makarov |
| [`pi-ui`](extensions/pi-ui/README.md) | minuque/pi-cc-extensions、tifandotme/pi-extensions、OldSuns/pi-open-tui、MarkedJS | 见下 | MIT（按来源分别保留） |
| [`pi-background-shell`](extensions/pi-background-shell/README.md) | [ismailsaleekh/pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks) | `471f1dcae7ff13d8f989e4c056bdff1e6b01f1ef`；npm `pi-background-tasks@2.6.8` | ISC |
| [`pi-add-dir`](extensions/pi-add-dir/README.md) | [HenryQW/pi-harness](https://github.com/HenryQW/pi-harness) | `4d9ed14b8016abcecb3d97af8c28ca37a3ca265f` | MIT |
| [`pi-ask-user-question`](extensions/pi-ask-user-question/README.md) | [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono) | 2.12.0，`68d9a0014b70006d7b04b57933752338a2716db7`（`packages/rpiv-ask-user-question`） | MIT / juicesharp |
| [`pi-subagents`](extensions/pi-subagents/README.md) | [AlexParamonov/pi-subagents-lite](https://github.com/AlexParamonov/pi-subagents-lite) | v1.15.1，`0a9ad2f14562daeec2b5d815fbdf42695f2e7f11`；选择性吸收 v1.16.0–v1.17.1，`682c9c73680dbd7e4bf754b4eccc9ed1a85d27fb` | MIT |

模块内记录（含完整变更清单与固定来源）：

- `context-view`：[UPSTREAM.md](extensions/context-view/UPSTREAM.md)
- `pi-ui`：[licenses/README.md](extensions/pi-ui/licenses/README.md)
- `pi-background-shell`：[UPSTREAM.md](extensions/pi-background-shell/UPSTREAM.md)
- `pi-add-dir`：[UPSTREAM.md](extensions/pi-add-dir/UPSTREAM.md)
- `pi-ask-user-question`：[UPSTREAM.md](extensions/pi-ask-user-question/UPSTREAM.md)
- `pi-subagents`：[UPSTREAM.md](extensions/pi-subagents/UPSTREAM.md)

## pi-ui

`pi-ui` 组合多个独立许可的来源，版权与许可文本逐项保留在
[`extensions/pi-ui/licenses/`](extensions/pi-ui/licenses/README.md)：

- `minuque/pi-cc-extensions` v0.8.69（`5d7a2666f51da9f450bd019af10200c88cc1df98`）
  与 v0.8.70（`26aa98df430fa4112c6880367b9d477c0ef53f1f`）的渲染、thinking、
  context、Markdown 和工具摘要模块；
- 选择性吸收 v0.9.10（`2b72669cafefe0771b2e3e63b0db5c478314d2d4`）的自适应
  摘要、轻量动画、尾部工作汇总、声明式动作、diff 省略语义和展开背景；
  不是整版同步，具体采用与未采用边界见模块许可通知；
- 另参考 v1.0.1（`0188b76f2597772bea3b42075857e030d9a89666`）的 fullscreen
  用户首行置顶、用户分界、组内展开、等待动画与 shell 耗时行为，以及 main
  `08ec91838842f15ec999850816a99435e7e15fbb` 的收起视口保持；
  语义工作汇总为本地设计，具体来源与取舍仍由模块记录持有；
- `tifandotme/pi-extensions` 的 `pi-compact-thinking`；
- `OldSuns/pi-open-tui` 0.3.1 的 footer 渲染、icons、运行时检测、usage 聚合与
  格式化，记录在
  [`licenses/pi-session-ui-UPSTREAM.md`](extensions/pi-ui/licenses/pi-session-ui-UPSTREAM.md)；
- MarkedJS / Christopher Jeffrey / John Gruber 的 reference-definition grammar。

## 共享库

`pi-ui-kit` 的工具卡渲染改自 pi-cc-extensions，许可通知随库复制；`pi-config-core`
与 `pi-apply-patch-protocol` 为自有代码。详见各包的 `UPSTREAM.md`。
