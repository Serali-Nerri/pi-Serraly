# pi-ui

Pi 1.0.0 的展示模块，将 Claude 风格转写与会话 shell 合并为一个独立入口。
本模块不注册或执行业务工具。工具自带 renderer 优先；真实内置工具以
`sourceInfo` 区分，同名扩展覆盖不会被误接管。文件/补丁卡的标题与结果状态行
使用共享 `pi-ui-kit` 的卡语法，diff/IO 正文、hover/hitbox、展开对象和动画帧
仍由本模块拥有。

## 行为与命令

- 欢迎面板、模型/目录/命令提示、footer、其他扩展状态、Git 和 runtime 信息。
- 常规工具卡、相邻分组、compact 轮次、文件/diff 卡及已返回内容的展开预览。
- Thinking 标题、预览、动画、独立耗时及全会话历史耗时恢复。
- 全屏鼠标展开/hover、正文拖选与链接；共享文字预览及 `/context` 六分类。

| 命令 | 行为 |
| --- | --- |
| `/ccstyle`、`/ccstyle panel` | 五页设置面板 |
| `/ccstyle on` | Claude 风格工具/消息展示 |
| `/ccstyle compact` | 轮次摘要及可展开过程视图，文件工具保留专用卡 |
| `/ccstyle off` | 恢复工具/摘要原展示；**不关闭** shell、Markdown 或独立 Thinking |
| `/ccstyle status` | 十二项有效设置 |
| `/context` | 上下文用量、来源、六分类和逐项预览 |

工具 schema、prompt、exposure、执行、安全及返回数据均由业务模块或宿主拥有。
UI 只展示已经返回或保存的数据；不读当前磁盘补全历史 diff，不隐藏工具自己的
截断提示，也不减少模型收到的结果。

## 配置

Pi 默认使用 fullscreen；宿主设置 `"tuiMode": "regular"` 或
`--tui-mode regular` 可选择 regular。fullscreen 由宿主路由鼠标事件；
regular 的鼠标与滚动历史由终端管理，工具展开仍可使用键盘。

继续使用 `$PI_CODING_AGENT_DIR/claude-style-tools.json`。启动只读且不创建文件。
显式保存时原子写入，保留未知字段，清理三个已废弃字段。

| 字段 | 默认值 |
| --- | --- |
| `mode` | `"on"` |
| `excludeRenderers` | `[]` |
| `writePreviewLines` | `10` |
| `editPreviewLines` | `14` |
| `fileExpandedMaxLines` | `80` |
| `useSummaryTitlesAsThinkingTitle` | `true` |
| `previewLines` | `3` |
| `animationIntervalMs` | `90` |
| `inputClip` | `100` |
| `expandedInputMaxLines` | `5` |
| `expandedOutputMaxLines` | `10` |
| `enableContextCommand` | `true` |

已删除 `dimThinkingText`、`expandedPreviewMaxLines`、`scrollStepLines`、旧 Task
专用展示和滚轮覆盖。滚轮遵循宿主 `fullscreenWheelScrollLines`。

## Markdown 与统计

保留五类 admonition、跨行链接区域修复、普通文本圈数字字体规避。
标准 Mermaid 和普通裸 URL 由宿主处理；仅对会被原生解析吞入的中文标点/
全角括号做显示层边界兼容。非标准图表围栏按普通代码显示。代码、原始消息、
会话数据和既有链接目标不变。少数含 Markdown/LaTeX 特殊字符的 `www` 路径
使用原生行内代码标签，保持字面文本及点击目标一致。

累计计费扫描全会话，包含独立 usage（`cache_warm` 和未知 kind）；独立 usage
不进入上下文分类或最近 assistant 缓存命中率。上下文使用活动投影；
未知显示 `?`，不显示为实测零。来源标签只在 `/context` 显示。

## 维护索引

- [UI 架构和所有权](docs/architecture.md)
- [隔离验证、预览与人工验收边界](docs/acceptance.md)
- [完整来源与许可证](licenses/README.md)
- [仓库开发指南](../../docs/development.md)

Thinking 持久化继续使用 `claude-style-tools-thinking-duration` 和
`{ messageTimestamp, contentIndex, durationMs }`；读取全会话历史，不重写旧会话。
