# pi-ui

独立 Pi 展示与会话命名扩展；拥有 Thinking、Footer、活动完成提示、置顶用户消息和可选的自动会话命名。不注册工具、模型或 Markdown 变换，不改写主会话消息。工具调用继续由 conversion 或工具自身渲染。

## 展示

- **Thinking**：连续 thinking 块合为一段。收到 `thinking_start` 即显示 Thinking 动画和耗时，不等待思考文本或摘要；没有开始事件前不猜测模型是否在思考。默认从 reasoning summary 的粗体标题提取标题，否则显示 Thinking / Thought；折叠时流式显示末尾 3 个视觉行，点击该段独立展开全文。初始显隐沿用宿主设置；Ctrl+T 整体切换清除局部选择，resize/更新/换主题不清除。耗时从真实 thinking 开始至结束计算，写入非模型上下文的 session 元数据；重开/分支切换只恢复当前分支中合法记录，没有记录不猜测耗时。
- **Footer**：目录、[Git 状态](#git-状态)、会话名、provider/model、thinking level、上下文比例和成本；保留其他扩展的 status。不显示 `working` / `done` 活动行或当前工具名。用量沿用 Pi 原生 `↑输入 ↓输出 R缓存读取 W缓存写入` 标记，累计整个会话（包括其他分支和压缩前记录）；有缓存统计时显示 `cache 50.1%`，口径为最近一次 assistant 请求的 `cacheRead / (input + cacheRead + cacheWrite)`，不是累计比例。无缓存读写量和无法计算的命中率不显示，不推测未知值。统计取自公开的 session usage 数据，不抓取原生 Footer 文本或读取私有统计对象。窄屏按可用宽度裁剪，不同步运行 Git 命令或逐帧扫描历史。
- **置顶用户消息**：仅 fullscreen；当用户消息首行滚出视口时，在 transcript 顶行显示最近的用户消息首行，点击定位原消息。普通模式沿用终端 scrollback。保留滚动条和原生拖选，不显示 assistant、工具或 Markdown 后续行作提示。
- **活动完成提示**：主代理真正停止后，在本轮内容下方右对齐显示弱提示 `Worked for 2m 18s · 14:32:08`；regular/fullscreen 都显示，窄屏单行裁剪。耗时从首次 agent start 到最终 settled，覆盖模型、工具、重试和自动继续，不累加并行工具时间、不等待后台子代理，扣除明确的 UI 等待输入（重叠等待只扣一次）。手动停止也用同一格式，无最终文字时仍跟在已有内容之后。结束时刻使用本地时间，非当天附日期。提示使用非模型上下文的 session entry，随对应可见历史恢复，不补算旧记录、不单独恢复压缩隐藏的内容；未收尾或切换会话/历史分支时不伪造完成记录。无需额外设置。

Thinking 和置顶提示使用包内隔离的 Pi 兼容适配；宿主能力不匹配时只关闭该项并告警，不影响 Footer 或工具。

### Git 状态

沿用 pi-open-tui 的紧凑 Git 段：分支名后按冲突、删除、修改、重命名、暂存、未跟踪、stash、领先/落后顺序显示非零计数，例如 ` main [!2 +1 ?3 ↑1]`。冲突/删除为错误色，修改/重命名/落后为警告色，暂存/领先为成功色；分叉同时显示领先/落后数。Detached HEAD 显示 `HEAD` 和 7 位提交号，不查询标签；分支名最多 20 列。

图标沿用上游自动模式：交互 UTF-8 终端使用 Nerd Font 图标，SSH 使用 Unicode，非 TTY、`TERM=dumb` 或非 UTF-8 locale 使用 ASCII。Git 不可用或目录不属于仓库时隐藏该段。

挂载、宿主分支通知、工具执行结束和回合结束时异步读取本地状态，不执行 fetch、不轮询，不在 render 中启动进程。每条 Git 命令最多 2 秒、输出最多 1 MiB，不刷新索引；新的刷新和组件卸载会取消旧读取。外部修改会在下一次这些事件发生时更新。

## 自动会话命名

在 `/ui` 中开启 **Automatic session names**，并用 **Naming model** 选择独立模型，或保留 **Follow chat model**。默认关闭，升级已有展示配置不会自动增加模型请求。模型选择器支持按 provider、模型 ID 搜索；选择命名模型不会切换主聊天模型。

启用后，未命名会话根据首条有效用户文本命名：先保存简短的首句标题，再后台生成最多 36 个 Unicode 字符的标题，沿用用户语言并保留完整字素。启用时已有用户消息的未命名会话也会处理；已有名称不会自动覆盖。名称通过 Pi 原生接口保存，Footer 和 `/resume` 使用同一名称，重新打开会话仍然保留。

命名请求只发送首条有效用户消息的有界文本摘录，跳过图片和展开的 skill 正文，不发送主会话系统提示、工具输出或完整历史。请求没有工具，不插入聊天消息，也不等待主回合结束。使用所选模型在 Pi 中已有的认证和 provider 配置；会消耗该模型额度，可能产生 API 费用，独立请求不计入主聊天的用量统计。

每个会话自动尝试一次。20 秒超时、模型不可用或请求失败时保留首句标题，不自动改用其他模型或 provider。若仍是自动保存的降级标题，调整命名设置可重试；成功生成后不会随每轮对话反复改名。手动命名继续使用 `/name`，包括与降级标题相同的名字，都会优先于待完成的自动结果。

关闭自动命名、改变命名设置、导航历史或切换/退出会话会取消相应的待完成请求；已经保存的名称不会因此清除。只在 TUI 会话中运行，RPC、JSON 和 print 模式不发起命名请求。已命名的子代理也不会产生额外命名请求。

## 设置

`/ui` 打开展示与命名设置。只在明确修改时原子保存到 `$PI_CODING_AGENT_DIR/pi-ui.json`（默认 `~/.pi/agent/pi-ui.json`）；不读取/迁移旧 UI 格式。

| 字段 | 默认 | 范围/含义 |
| --- | --- | --- |
| useSummaryTitlesAsThinkingTitle | true | reasoning summary 标题 |
| previewLines | 3 | 0–20 个尾部视觉行 |
| animationIntervalMs | 90 | 40–1000 ms；只影响活动标题扫光动画，按完整 Unicode 字素着色，长标题裁剪后仍保持动画 |
| stickyUserMessage | true | fullscreen 置顶首行 |
| autoSessionName | false | 自动生成原生会话名；会使用模型额度 |
| sessionNameModel | null | `null` 跟随当前聊天模型；`{"provider":"…","id":"…"}` 固定命名模型 |

缺失、非普通文件、非法 UTF-8、无效或超过 64 KiB 的配置只读回退默认值；无效命名模型配置也关闭自动命名，不静默改用主模型。保存失败不更新内存，拒绝覆盖非正常 JSON 文件；有效 JSON 中的错误模型字段可通过重新选择模型修正。不会自动创建配置。

## 生命周期与性能

只在 TUI session 启动资源；shutdown/reload/切换幂等清理计时器、订阅、兼容适配、命名请求和缓存。组件不捕获完整 context/lastComponent 或保留旧流式帧。预览只折行有界尾部窗口，展开布局由宿主 Markdown 缓存当前全文/宽度；历史恢复索引最多 2048 段，单段只保留当前布局。动画只请求宿主重绘，扩展不读取会话历史或重新构建消息，预览折行按当前文本和宽度缓存。Footer 用量按完成消息增量更新，只在会话/分支/压缩边界从所有会话记录重建；Thinking 历史恢复只读取当前分支。

## 本地使用

按 [development](../../docs/development.md#本地安装工作区) 准备独立安装工作区，再运行 `pi install ~/.pi/pi-Serraly/packages/pi-ui`；也可通过 [pi-extensions](../pi-extensions/README.md) 整合包启用，不要重复登记。

构建将包内模块合为已去除类型的单个 `dist/index.ts` ESM 入口，Pi host imports 保持 external。公开类型入口为 `types/index.d.ts`，其工厂签名与源码保持一致。`.ts` 运行入口让 bundled Pi 的 loader 保留实际宿主组件绑定；原生 `.js` 入口或内部 `.js` import 会绕过该绑定，不能用于此私有适配。编译产物通过真实 bundled Pi loader 验证展示与回收，不能把宿主类打进产物。运行依赖只有 Pi host peers。来源见 [UPSTREAM.md](UPSTREAM.md)，许可见 LICENSE 和 licenses/。
