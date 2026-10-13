# context-view

独立的 Pi 1.2.0 扩展，保留 pi-context-view 的 Usage、Initial 注入、配置和内容预览。
入口为 `dist/context-view.js`，只注册 `context` 命令，不注册业务工具。
可单独选择，也可与 pi-ui 按任意顺序共存；pi-ui 的 Footer 与 `/ccstyle` 不由本模块接管。
安装与选择性 release 遵循[仓库开发指南](../../docs/development.md)，不要将开发 dist 加入真实 settings。

## 命令与查看

- `/context` 或 `/context usage`：当前会话分支的组成与 token **估算**，不是最终请求。
- `/context injections`：本扩展 runtime 首次被动捕获后冻结的 **Initial**。
- `/context tools`：宿主工具库存与最近一次工具声明观测；Usage / Injections 内按 `t` 也可进入。
- `/context config`：显式创建默认显示偏好；非 TUI 模式也可用。
- Usage / Injections / Tools 仅 TUI 可用；参数补全提供以上四项。

方向键选择/滚动，Enter 打开内容，Esc 返回/关闭；PgUp/PgDn、Home/End 滚动预览。
Usage 可展开分类、查看正文和 JSON，并使用地图缩放；Injections 可查看 prompt、
指令文件、skills、工具定义和扩展注入。地图适应终端宽高，CJK 和长正文按可见宽度布局。
fullscreen 的归一化鼠标 wheel 使用公开的逻辑行增量；原始 wheel 报告回退为三行，
regular 的终端原生 scrollback 不被接管。

## 捕获与边界

只在宿主正常 `before_agent_start` / `context` 流程中捕获 Initial。
用户消息和空闲时触发工作活动的自定义消息都参与捕获；Initial 冻结首次完整
捕获，而不是首次用户输入。后续活动不重写已冻结的 Initial。
打开、关闭或预览不发送探测消息、不 abort、不执行或激活工具、不改写请求、
不更改 warming 设置。首次请求准备前显示 **Not captured. Session estimate only.**
及扩展 additions 未观测提示；该 view-local fallback 不冻结 Initial，真实请求后可得到捕获。
捕获标为 real-turn（本扩展 context handler 所见），fallback 与 Usage 标为 session-estimate。
Initial 不是 provider payload、最终 wire 或发送/接受证明；active 工具估算不等于请求声明。

## 工具诊断

Tools 将打开视图时采样的 `getAllTools()` 库存、来源、Tool Exposure 与 `getActiveTools()`
名单，和最近一次 **before_provider_request（本扩展 handler 位置）** 的声明分开呈现。
观测显示时间，不用当前选择模型猜测实际路由；事件只有 payload，没有请求身份或严格用途。
来源未知，可能包括 cache warming。它不是最终 wire、已发送或 provider 已接受的证明。

支持 **Anthropic-shaped collapsed 顶层 `tools[i]`** 与 **原生增量**：system 消息中的
`tool_addition.tool.definition` / `tool_removal.tool.name`，展示实际 `input_schema` 与具体路径。
从顶层初始定义开始，按 payload 消息、block 顺序应用移除与同名重定义；只有整份声明协议
可靠解码时才展示 **effective declarations**。原生初始 baseline 与更新历史单列保留位置、
顺序与原定义，不把初始/历史新增累计为当前有效集合。已知 `__pi_deferred_placeholder__` 的 adapter 形状单列标为
placeholder，排除在有效声明及注册/推导可调用库存之外；其他 deferred 定义或未知结构不猜测。
其他格式、畸形/不完整的原生协议及解码失败显示 Unknown（不宣称有效集合）；
尚未触发 handler 则为 Not yet observed。每次新观测替换旧槽位，即使失败也不继续显示旧定义。
库存信息不是请求证据，不拿注册 schema 填充观测。

支持的定义边界是 adapter 生成的自定义工具：非空字符串 name、字符串 description、
无 provider-specific type / defer_loading 字段（已知 placeholder 除外），以及 `type: "object"` 的根 input_schema。
结构检查递归覆盖 schema 映射（properties、patternProperties、$defs、definitions、dependentSchemas）、
schema 列表（allOf / anyOf / oneOf、prefixItems）、items（含 tuple 形式），以及
additionalProperties / additionalItems、unevaluatedProperties / unevaluatedItems、propertyNames、
contains、not、if / then / else、contentSchema 的子 schema；子 schema 可为对象或 boolean。
type 须为合法 JSON Schema 类型或类型数组，required / dependentRequired 须为字符串数组，
dependencies 可为子 schema 或字符串数组。strict 须为 boolean，eager_input_streaming 可为
boolean 或 null，cache_control 可为 null 或 `{type: "ephemeral", ttl?: "5m" | "1h"}`，
原生更新 block 的 cache_control 同样检查。任何这些支持字段的畸形形状使整份最新观测为 Unknown，
不留下旧有效定义。其余合法 JSON 注解/扩展保留在 schema 中；这是有界结构检查，
不是完整 JSON Schema 验证器，不解析 $ref、不检验参数实例，也不证明 provider 接受该 schema。

观测到的 **codemode description** 有独立预览；其中的内联签名属于描述内容，不另计独立声明，
不做通用签名 AST 解析。codemode `only` 可隐藏 active eager 的独立声明而保留描述内联；
active 但无独立声明不自动判错。真实 `tool_search` 可激活匹配延期工具，codemode
`searchTools` 是纯搜索、返回签名但不激活。普通消息、schema 字符串和搜索结果始终是内容，
不会因含工具名/schema 而成为协议声明；没有独立声明不等于 schema 在所有内容中不可见。

内部调用资格仅按曝光模式与 active **推导**，不是执行验证：direct 仅 active 时可调用；
codemode / deferred 即使 inactive 仍可内部调用；model-only 可以 active / 有声明但不可内部调用；
hidden 与 inactive direct 不可内部调用。active 不是 callable 或声明的别名，集合差异不自动判错。
Enter 预览选中库存元数据、有效观测定义、按序更新记录、placeholder 或 codemode 描述，Esc 返回；`u` / `i` 回到 Usage / Initial，方向键、
PgUp/PgDn、Home/End 与 wheel 沿用查看器导航。长 schema 与多语言文本在预览中换行并可滚动。

handler 同步复制所需工具声明数据（name、description、input_schema 及已知的
strict / eager_input_streaming / cache_control 字段），不保留无关 envelope、整个 payload、
消息引用；增删历史只来自当前 payload，不是跨请求历史。只读自身数据属性，不调用 accessor / toJSON；结构或复制超过 20,000 节点、
64 层或约 2 MiB 字符预算时整份观测为 Unknown，不呈现部分成功结果。不改写或 freeze
业务对象；后续 handler 原地/替换改写不改变已捕获内容。捕获失败静默降级，不阻断请求、
不通过日志或通知泄漏内容。仅本 runtime 最新一份观测留在内存，reload / restart / 新 runtime
均从 Not yet observed 开始，不从会话恢复；查看/预览不探测、不激活、不执行工具、不改 warming。

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
公开宿主加载/命令/TUI（含 Usage / Initial 返回 overlay 组件的 wheel 转发）、
真实 tool_search 与 Anthropic adapter 的请求局部假 fetch/SSE、
配置和预览行为及现有 packed/release seam 共同验收，
不依赖兄弟源码或真实凭据。

[MIT 全文](LICENSE)，作者 Dmitry Makarov；固定来源及保留/省略边界见 [UPSTREAM.md](UPSTREAM.md)。
