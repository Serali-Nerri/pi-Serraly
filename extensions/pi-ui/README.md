# pi-ui

Pi 1.3.0 的展示模块，将 Claude 风格转写与会话 shell 合并为一个独立入口。
本模块不注册或执行业务工具。工具自带 renderer 优先；真实内置工具以
`sourceInfo` 区分，同名扩展覆盖不会被误接管。文件/补丁卡的标题与结果状态行
使用共享 `pi-ui-kit` 的卡语法，diff/IO 正文、hover/hitbox、展开对象和动画帧
仍由本模块拥有。

## 行为与命令

- Footer、其他扩展状态、Git 和 runtime 信息。启动头由 Pi 原生渲染，本模块不覆盖。
- 常规工具卡、相邻分组、compact 轮次、文件/diff 卡及已返回内容的展开预览。
- compact 折叠保留文件卡和单行尾部汇总；展开在原会话位置恢复过程内容，
  不把普通工具集中搬到一个面板，过程说明和 write/edit/apply_patch 卡保持原顺序。
- Thinking 标题、预览、动画、独立耗时及全会话历史耗时恢复。
- 全屏鼠标展开/hover、正文拖选与链接；文字预览、滚动与退出。
- fullscreen 且 ccstyle 为 `on` 或 `compact` 时，默认置顶已滚出视口上沿的用户消息正文首行。
  置顶提示按当前查看位置选择指令；后续用户消息越过同一上沿后接替。点击置顶文字跳回
  原消息，鼠标命中只覆盖绘制的文字范围，不占用滚动条列；滚动、缩放、会话切换后的旧坐标
  不触发跳转，reload 后旧宿主帧不会影响新会话的置顶交互。窄窗口按列裁剪，不拆开宽字符；
  单行视口与原生跳到末尾提示冲突时保留原生提示。regular 与 `off` 模式不显示。

本模块只注册 `/ccstyle`，不拥有上下文 Inspector 或注册 `/context`。

| 命令 | 行为 |
| --- | --- |
| `/ccstyle`、`/ccstyle panel` | 四页设置面板 |
| `/ccstyle on` | Claude 风格工具/消息展示 |
| `/ccstyle compact` | 轮次摘要及可展开过程视图，文件工具保留专用卡 |
| `/ccstyle off` | 恢复工具/摘要原展示；**不关闭** shell、Markdown 或独立 Thinking |
| `/ccstyle status` | 十三项有效设置 |

工具 schema、prompt、exposure、执行、安全及返回数据均由业务模块或宿主拥有。
UI 只展示已经返回或保存的数据；不读当前磁盘补全历史 diff，不隐藏工具自己的
截断提示，也不减少模型收到的结果。

## 宿主能力预检

兼容补丁按引用替换 Pi 1.3.0 的展示方法（工具/助手/容器/三种摘要组件的
`render`、`updateDisplay`、`createResultRegion`、`dispatchMouseToLayout` 等）。
每个 TUI `session_start` 在 thinking 与 transcript 修改之前做一次无写入预检：
只读 descriptor、继承与 extensibility，不执行 getter，也不写任何槽位。
所有必需补丁目标原型都必须可扩展，以便注册 pipeline 槽位；即使方法已在原型
自身定义且可写，禁止扩展或 sealed 的原型也不能安装补丁。缺少
必需能力、方法不可替换或原型不可扩展时，整个兼容域被跳过（原生展示、shell、
命令和 Markdown 继续工作），每 session 只通知一次并列出具体能力名；安装器仍
在自身位置保留就地检查，防止预检后出现竞态。预检只证明公开方法可替换，
不证明私有实例字段布局稳定，实际宿主与人工视觉验收仍是必需的。

## 补丁所有权

兼容补丁通过 `Symbol.for` 槽位跨 `/reload` 交接。只有本模块写入的 owner 与
原型 pipeline 会带上 `Symbol.for("pi-serraly.ui.patch-owner")` 品牌；槽位里出现
未标记的值——即使它带有 `dispose`/`stop` 或形状相似——一律视为 foreign：
不调用、不接管、不覆盖，也不会被 shutdown 删除。发现 foreign 时兼容域在修改
任何槽位之前整体失败，每 session 只通知一次并给出具体槽位名。上游槽位名保持
不变以便发现冲突，但不会自动兼容未知 patch。安装后外部替换 wrapper 或槽位时，
shutdown 只按 identity 释放自己写入的值，保留外部值。`/ccstyle off` 只恢复原生
展示，只有真正禁用入口才卸载本模块的补丁。

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
| `inputClip` | `0`（不预裁剪，按可用终端宽度展示；显式正值仍限制字符） |
| `expandedCardBackground` | `"userMessageBg"` |
| `expandedInputMaxLines` | `5` |
| `expandedOutputMaxLines` | `10` |
| `stickyUserMessage` | `true`（UI 页可关闭置顶用户提示） |

单卡、相邻分组与 compact eligible-tool 共享摘要取值：PowerShell 显示命令，
grep/find 显示表达式和存在的路径范围。摘要预算取终端宽度的 80% 与宽度减 24 列
的较大值，并扣除标题、状态、分支和 detail；路径仍优先保留文件名与原分隔符。

`expandedCardBackground` 接受宿主语义背景槽位：`userMessageBg`、`toolPendingBg`、
`toolSuccessBg`、`toolErrorBg`、`customMessageBg`、`selectedBg`、`searchMatchBg`；非法值回退默认。
它统一用于 UI 管理的展开工具/文件/补丁卡、工作组、消息和独立 Thinking；
专用 renderer 保持自己的背景，diff 增删背景、hover 和选区仍有区别。

动画帧只请求重绘，字形在 render 时读取；真实结果、展开、设置和主题更新仍正常失效。
鼠标展开/预览只匹配展示模块声明的操作行及其文字区域，正文里的同款提示不是操作。
原生 edit diff 的前部/中间省略显示在 gutter；尾部上下文省略不算可展开的保留内容。
文字预览直接使用宿主归一化鼠标事件的本地坐标和完整滚轮行数，仅滚动条拖拽捕获指针；
regular 输入路径仍接受原始终端鼠标数据。完成标记使用主题的 `success` 颜色。

已删除 `dimThinkingText`、`expandedPreviewMaxLines`、`scrollStepLines`、旧 Task
专用展示和滚轮覆盖。滚轮遵循宿主 `fullscreenWheelScrollLines`。

## Markdown 与统计

保留五类 admonition、跨行链接区域修复、普通文本圈数字字体规避。
标准 Mermaid 和普通裸 URL 由宿主处理；仅对会被原生解析吞入的中文标点/
全角括号做显示层边界兼容。非标准图表围栏按普通代码显示。代码、原始消息、
会话数据和既有链接目标不变。少数含 Markdown/LaTeX 特殊字符的 `www` 路径
使用原生行内代码标签，保持字面文本及点击目标一致。

累计计费扫描全会话，包含独立 usage（`cache_warm` 和未知 kind）；独立 usage
不进入 Footer 上下文用量或最近 assistant 缓存命中率。Footer 上下文使用活动投影，
保留用量快照缓存及模型、会话与上下文变化后的失效；未知显示 `?`，不显示为实测零。

## 维护索引

- [UI 架构和所有权](docs/architecture.md)
- [上游展示改动的吸收取舍](docs/upstream-selection.md)
- [隔离验证、预览与人工验收边界](docs/acceptance.md)
- [完整来源与许可证](licenses/README.md)
- [仓库开发指南](../../docs/development.md)

Thinking 持久化继续使用 `claude-style-tools-thinking-duration` 和
`{ messageTimestamp, contentIndex, durationMs }`；读取全会话历史，不重写旧会话。
