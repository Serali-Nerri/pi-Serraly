# pi-session-recap

交互式 Pi TUI 的轻量会话摘要，参考 OpenAI Codex 的 recap。使用 `/recap` 手动生成，或在 agent 完全结束并空闲 30 分钟后自动生成。

**自动模式默认开启，会产生模型用量。** 至少完成 3 次用户 exchange 后才自动生成；成功 recap 后还需完成 2 次新 exchange。按键会重新计时，鼠标滚轮不会。

## 使用

在准备好依赖的独立安装工作区中，按仓库 [交付流程](../../docs/development.md#本地安装工作区) 注册本包：

```sh
pi install /path/to/pi-Serraly/packages/pi-session-recap
```

无需构建。不包含在 `pi-extensions` 整合包中。仅支持 Pi ≥1.4.0 的 TUI；print、JSON、RPC 模式的 `/recap` 不请求模型。

生成时 footer 显示 `drafting recap...`，完成后编辑器上方显示 `Recap:` 和可选的 `Next:`，最多 10 个渲染行。下一次提交消息/命令或新 turn 会清除卡片；空 Enter 也会清除。普通编辑和滚动保留卡片。结果只存在内存中，不写 transcript，不进入模型上下文，恢复会话不会重现。

摘要只使用当前分支的可见 user/assistant 文本，忽略工具结果和 thinking。保留最近 8 个已完成 exchange 及最新未回复请求，提示词与历史总计不超过 32 KiB。已有工具步骤但尚未结束的 exchange 整段排除。Streaming 时 `/recap` 立即使用这些已完成历史，不等待 agent。

自动请求在按键/新 turn 时取消；手动请求在提交新消息/新 turn 或切换会话时取消。自动失败 30 秒后重试一次，最终失败静默停止，直到下次活动重新计时。手动失败通知用户；同时只能生成一份 recap。

## 配置

首次加载创建 `<agent-dir>/session-recap.json`，默认 agent-dir 为 `~/.pi/agent`（遵循 `PI_CODING_AGENT_DIR`）：

```json
{
  "auto": true,
  "idleMinutes": 30,
  "minTurns": 3,
  "minTurnsBetweenRecaps": 2,
  "recapModel": null
}
```

设 `auto: false` 可只用手动命令。`idleMinutes` 为正数；两个 turn 门槛为正整数，按已完成的用户请求计数，不按工具步骤计数。`recapModel` 可设为 `"provider/model"`；默认使用当前会话模型，thinking 关闭或使用该模型支持的最低级别。覆盖模型无效/无可用认证时警告一次并回退当前模型，不修改主 agent 的模型或 thinking。

非法字段回退各自默认值；无法读取/解析配置时使用默认值并警告一次。修改后 `/reload` 或重新启动生效。自动摘要不会提供缺乏对话依据的下一步；其内容仍是模型生成的，未验证事项应保留在摘要中。

## 来源与许可

原创实现使用 MIT；提示词及历史选择算法改编自 OpenAI Codex，使用 Apache-2.0。固定来源、修改与条款见 [UPSTREAM.md](UPSTREAM.md)、[NOTICE](NOTICE) 和 [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)。
