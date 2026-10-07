# context-view

独立的 Pi 1.0.4 扩展，保留 pi-context-view 的 Usage、Initial 注入、配置和内容预览。
入口为 `dist/context-view.js`，只注册 `context` 命令，不注册业务工具。
可单独选择，也可与 pi-ui 按任意顺序共存；pi-ui 的 Footer 与 `/ccstyle` 不由本模块接管。
安装与选择性 release 遵循[仓库开发指南](../../docs/development.md)，不要将开发 dist 加入真实 settings。

## 命令与查看

- `/context` 或 `/context usage`：当前会话分支的组成与 token **估算**，不是最终请求。
- `/context injections`：本扩展 runtime 首次被动捕获后冻结的 **Initial**。
- `/context config`：显式创建默认显示偏好；非 TUI 模式也可用。
- Usage / Injections 仅 TUI 可用；参数补全提供以上三项。

方向键选择/滚动，Enter 打开内容，Esc 返回/关闭；PgUp/PgDn、Home/End 滚动预览。
Usage 可展开分类、查看正文和 JSON，并使用地图缩放；Injections 可查看 prompt、
指令文件、skills、工具定义和扩展注入。地图适应终端宽高，CJK 和长正文按可见宽度布局。
fullscreen 的归一化鼠标 wheel 使用公开的逻辑行增量；原始 wheel 报告回退为三行，
regular 的终端原生 scrollback 不被接管。

## 捕获与边界

只在宿主正常 `before_agent_start` / `context` 流程中捕获 Initial。
打开、关闭或预览不发送探测消息、不 abort、不执行或激活工具、不改写请求、
不更改 warming 设置。首次请求准备前显示 **Not captured. Session estimate only.**
及扩展 additions 未观测提示；该 view-local fallback 不冻结 Initial，真实请求后可得到捕获。
捕获标为 real-turn（本扩展 context handler 所见），fallback 与 Usage 标为 session-estimate。
Initial 不是 provider payload、最终 wire 或发送/接受证明；active 工具估算不等于请求声明。
当前命令不提供工具声明诊断。

捕获与预览仅在 runtime 内存中；不写快照、捕获日志或自定义会话条目。
重启/reload 的新 runtime 不从历史重建 Initial 观测。Usage 可估算正常宿主会话记录，
不将重放称为捕获。预览清洗终端控制字符，省略图片 base64 与不透明签名。
宿主自身正常会话保存不受影响。

## 显示偏好

路径为 `<agentDir>/extensions/context-view.json`（默认 `~/.pi/agent/extensions/context-view.json`），
无项目层文件、旧名称/旧键迁移或捕获内容。查看不会创建文件；
`/context config` 用独占 create-only 写入，已有文件、目录、链接路径及并发创建均不覆盖。
删除某个键即使用默认值；文件 mtime 改变后重开 Usage 应用编辑。
读取复用 pi-config-core 的 **64 KiB** 上限和严格 UTF-8 / 普通文件检查：
缺失静默默认，读取/JSON/形状错误回退默认并警告；无效或未知字段逐项忽略，
其余有效字段仍应用。警告在 Usage 中每次文件修订报告一次。

`mapCols` / `mapRows` 默认 16，各接受 4–64 的整数，实际地图再按 viewport 缩小。
颜色接受 Pi 前景 theme 名或 `#rgb` / `#rrggbb`：

| 键 | 默认 |
| --- | --- |
| systemPromptColor | mdHeading |
| instructionFilesColor | mdCodeBlock |
| skillsColor | customMessageLabel |
| builtInToolsColor | mdHeading |
| customToolsColor | accent |
| mcpToolsColor | mdLink |
| userMessagesColor | syntaxString |
| assistantMessagesColor | syntaxFunction |
| assistantThinkingColor | thinkingXhigh |
| toolCallsColor | syntaxKeyword |
| toolOutputColor | toolOutput |
| extensionsColor | syntaxType |
| compactedDataColor | thinkingHigh |
| autoCompactBufferColor | dim |
| freeSpaceColor | dim |

## 开发与来源

`npm run build --workspace context-view` 构建并密封独立 bundle；
`npm run check --workspace context-view` 严格检查源码与测试；
`node scripts/test.mjs --package context-view` 使用隔离原生 node:test 与网络拒绝。
公开宿主加载/命令/TUI、脚本化请求、配置和预览行为及现有 packed/release seam 共同验收，
不依赖兄弟源码或真实凭据。

[MIT 全文](LICENSE)，作者 Dmitry Makarov；固定来源及保留/省略边界见 [UPSTREAM.md](UPSTREAM.md)。
