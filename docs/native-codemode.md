# 原生 Codemode 工具扩展计划

状态：问答已结束；已确认范围如下，末轮未回答事项保留待决，尚未授权实现。本文是当前方案，不是问答记录。

## 目标

提供一个独立、通用模型可用的工具编排扩展，以已发布 Pi 的原生 codemode 执行工具，保留低上下文、按需发现工具的体验。不是给 PCC 增加新的执行模式，也不是复制 PCC 的运行时。

## 已同意的决策

- 独立扩展：只保留工具编排和延迟发现，不继承 PCC 的 Codex/provider 请求适配、语音、压缩、专用提示词等整套功能。
- 原生执行与渲染优先：采用 Pi 原生 codemode 卡片，不要求复刻 PCC 的嵌套卡片交互；PCC 现有模式保持不变。
- 默认操作工具确定为 `read/bash/grep/find/ls/apply_patch`；不提供重叠的 `edit/write`，不默认引入 `exec_command/write_stdin`。扩展/MCP 工具遵守已有允许范围。
- 首版直接复用 PCC 根公开导出的 `createApplyPatchTool`，不拆分共享包，不激活 PCC 扩展；接受完整 PCC 包和原生 helper 的库级依赖。
- 接受原生 `only + 0` 配合简短分组目录与追加式工具变化公告的大方向，但六个核心工具应预先给出调用契约，其他工具再按需发现；不把“所有契约延迟”视为既定要求。核心契约的承载方式及是否同时保留顶层入口尚未确认。
- 尊重 Pi 的 exposure 边界：`model-only` 工具保留其顶层入口，不强行改造成脚本可调用工具。
- 仅使用已发布 Pi 的公开 API，不修改或补丁化 Pi，不依赖其私有运行时或渲染器。

## 已查明的边界

### 原生工具暴露与延迟发现

- `codemode.mode: "only"` 把可经脚本调用的直接工具从顶层声明中隐藏，仍保留其调用资格。它不等于把所有工具改为 `deferred`。
- 原生 `codemode` 的工具参数是脚本；其描述中可附带嵌套工具说明、TypeScript 调用声明和使用规则，而不是再挂一组顶层工具 schema。
- `codemode.inlineBudget` 默认 `3000`，按字符数 / 4 估算 token。预算容纳的非 deferred 工具会内联，溢出工具按需发现；真正的 deferred 工具不内联。
- `inlineBudget: 0` 不列出任何单个工具名称、摘要或签名，仅保留脚本说明、全局变量说明和部分命名空间信息。因此它本身不提供 PCC 式逐工具简短目录。
- 原生预算没有“只内联指定六个核心工具”的白名单选项，不能靠预算值准确实现这一策略。公开 `prepareLoadout` 只能改描述或隐藏声明，不能就地修改其他工具的 exposure。
- 可行的薄适配方向是：原生 `only + 0`，扩展通过公开 `before_agent_start` 提供独立的核心契约提示节及其他工具短目录；不改第三方注册，不复制运行时。这是扩展提示节，不是原生选择性内联功能，仍待用户接受。
- 公开包 `@earendil-works/pi-codemode` 提供签名/schema 格式化函数，但不属于已文档化的扩展宿主映射包；`getAllTools()` 也不提供完整输出 schema。不能承诺仅靠工具元数据精确复刻所有原生返回类型声明，或为此导入 Pi 私有模块。
- `ALL_TOOLS` 是可调用工具的 `{ name, description }` 目录；`description` 包括说明、使用规则及生成的 TypeScript 调用声明，不只是短摘要。脚本可筛选后输出需要的条目；输出整个数组会把全部契约带入上下文。
- 原生还提供 `searchTools`、`describeTool`、`describeNamespace`。生成的 TypeScript 声明可能因复杂 schema 的大小限制降为 `unknown`，不能承诺无损导出完整 JSON Schema。
- 必须区分三种“延迟”：契约不提前进入模型上下文、运行时首次调用加载、MCP 后台连接。`only` 主要控制入口，预算控制契约内联；原生机制不等同于 PCC 的全部加载行为。

### 哪些工具能够接管

- `direct` 工具只有激活后可由 codemode 调用；`codemode/deferred` exposure 的工具注册后即有脚本调用资格，即使未激活。
- `model-only` 工具不能经 codemode 调用，`hidden` 工具不可达。不能声称所有已注册扩展工具都能强制纳入唯一脚本入口。
- MCP 默认适用原生发现和后台连接规则；应保留服务器启用状态、权限与用户显式选择，不额外绕过限制。
- 原生是一次性 QuickJS 脚本，提供 JSON `store/load`，没有 PCC `exec/wait` 或持久 Notebook 变量；不为本计划重建这些能力。

### 文件修改与 PCC 复用

- PCC Code/Notebook 等适配模式会移除默认 `read/bash/edit/write`，主要以 shell 读取，以 `apply_patch` 修改文件；其自身嵌套工具没有另一个 `edit/write`。
- PCC 的 `apply_patch` 并不延迟契约：核心工具通过 `toNestedTool` 的默认 `deferLoading: false` 提供调用说明，桥接的普通 Pi 工具才明确设置延迟。不能把“像 PCC 一样”误解成所有工具都延迟。
- 这不是禁止所有写入通道：shell 和其他允许工具仍可能修改文件，手动重新启用的工具也需按实际加载策略处理。
- `apply_patch` 支持文本文件新增、修改、删除、移动，可承担通常的 `write/edit` 工作；不把它描述为任意二进制写入工具。
- PCC 包根已公开导出 `createApplyPatchTool`，可只复用工厂而不激活 PCC 扩展。代价是依赖完整 PCC 包及其打包原生 helper；提取独立共享包则会扩大本次改动范围。
- 原生工具调用应使用公开定义的对象参数 `tools.apply_patch({ input: patch })`，不承诺 PCC 私有嵌套适配里的 `tools.apply_patch(patch)` 字符串快捷写法。
- 复用时还需接入公开 `registerApplyPatchResultEvent`：PCC 的部分失败返回 `details.status: "partial_failure"`，由此钩子标记 `isError: true`。验收必须确认失败会保留已修改文件和恢复提示，而不是误报整批成功。

### 渲染与配置集成

- 原生外层卡片及内部调用状态由 Pi 持有；内部工具自己的 renderer 不会自动成为原生 codemode 的独立嵌套卡片。本计划不补造这套 UI。
- 公开 `createCodemodeExtension({ mode: "only", inlineBudget: 0 })` 可创建完整原生定义。CLI 中同名注册会替换内置 codemode，而不是配置原有定义；需验证替换提示和唯一注册。
- 如果不替换定义，则依赖用户/项目的 `codemode` 设置。扩展 API 没有修改这些设置的运行时 setter；本计划尚未授权更改真实设置。
- 原生工厂及核心 API 在已发布 Pi `1.4.0`、`1.5.0` 均存在。这里只是 API 核对，不等于已经做过运行验收。

## 重要取舍与用户理由

- 用户只需要工具能力，因此独立薄扩展比继续增加 PCC 执行模式更符合边界。
- 用户接受 Pi 原生卡片，因此不为兼容 PCC 卡片保留第二套执行与渲染机制。
- 用 `apply_patch` 合并编辑入口可减少重叠工具；首版通过现有公开工厂复用，避免跨包重构扩大范围。
- 用户指出核心操作工具高频使用，不应仅为追求零内联而让每次使用前先发现契约。目标是核心工具立即可用、其他契约按需进入上下文，而非机械采用全零预算。
- PCC 式初始分组目录和后续增量公告属于轻量提示内容适配，不是原生 `only` 自动提供的能力。
- “其他基本不变”限定为工具编排体验，不包含 PCC 的持久 Notebook、宿主进程能力、全部 provider 行为或原有卡片。

## 建议落地路线（未确认细节不视为已同意）

1. **工具与提示**：建议六个核心工具的契约常驻，但实际调用仍统一经 codemode；扩展/MCP 只给简短目录，完整契约通过原生发现接口获取。目录按实际可调用集合生成，不把所有已注册工具都宣称可用。
2. **原生定义**：建议由公开工厂提供固定 `only + 0` 配置，不写真实 settings；先验证 CLI 同名替换行为。若不接受替换，则改为明确的原生设置前置条件，不偷偷降级。
3. **补丁工具**：注册公开 `createApplyPatchTool` 与 `registerApplyPatchResultEvent`，启用实际可用且允许的核心工具，排除默认 `edit/write`；不激活 PCC 主扩展，不引入字符串参数兼容层。
4. **加载与公告**：只适配契约的常驻/按需策略，运行时和 MCP 连接继续由原生机制负责。初始目录与后续变化公告分开处理，按会话/分支恢复，避免重写旧工具消息；不把可变系统提示节误称为追加式公告。
5. **所有权**：建议首版让 PCC 工具适配与新扩展二选一，不靠加载顺序抢占，不为共存重写 PCC。PCC 作为库依赖可存在；同时启用其工具编排则另定范围。
6. **启用方式**：建议加载扩展即生效，不另建模式菜单；仍须尊重启动限制、第三方 exposure 与 MCP 启用状态。是否采用这一默认值尚未确认。

## 待决问题

1. 核心契约“直接暴露”是指预置在 codemode 使用说明内、仍经脚本调用，还是同时开放六个顶层工具？前者更符合最初统一脚本入口的目标。
2. 是否接受 `only + 0` 加扩展常驻核心契约区的薄适配？原生没有选择性内联配置，不能把这一点当作开箱即用。
3. 原生配置由扩展通过公开工厂固定，还是作为用户/项目配置前置条件。
4. 扩展的默认启用方式、退出恢复、与 PCC 同时加载时的边界；末轮关于固定配置、二选一和加载即启用的建议未获回答，不能当作授权。
5. 首版具体兼容目标与验收范围；真实登录/模型 TUI 验收需另行明确授权。

## 建议的下一步

1. 用户若决定继续，先解决上述待决项，再明确授权实现；当前停在计划阶段。
2. 核对独立包名称、公开依赖与打包资源，细化唯一工具拥有者、启停恢复和目录生命周期；不修改 PCC 原有模式。
3. 用隔离、离线环境验证 Pi `1.4.0` 基线与 `1.5.0`：六工具可用且 `edit/write` 不重叠、入口与 exposure 正确、核心契约常驻且其他契约延迟、目录变更与会话/分支恢复正确。MCP 晚加载需受控夹具；真实连接另需授权。
4. 验证 `apply_patch` 成功与部分失败、原生脚本输出和嵌套状态、失败/取消、CLI 定义替换，以及不使用 helper 覆盖的真实打包资源。优先静态检查与一次性探针，不默认新增永久测试；跨包/构建/安装改动按仓库要求运行 `npm run verify`。
5. 真实登录/模型验收只能在用户明确授权后，经 Herdr 操作隔离 Pi TUI 连续执行工具；刷新安装候选后再测，不能把宿主源码或程序化探针当作已验收。

## 本轮交付与验证状态

- 仅新增本文；未修改扩展源码、依赖、安装目录或真实设置，未开始实现。
- 调研依据是仓库源码、发布版文档/公开声明及网页核对；没有执行候选包、联网 MCP 或真实模型验收，不宣称运行结果已验证。
- 问答已由用户关闭，不再追加问题；未答事项保留，推荐项不升级为约定。

## 调研依据

- 已发布 Pi `1.5.0` 的 `docs/codemode.md`、`docs/settings.md`、`docs/extensions.md`、`docs/mcp.md`，并对照 `1.4.0` 公开声明。
- [上游 codemode 文档](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/codemode.md)（网页 main 不替代发布版契约）。
- `packages/pi-codex-conversion/src/adapter/activation/activation.ts:237`、`packages/pi-codex-conversion/src/adapter/code-mode.ts:117`：默认工具替换与嵌套工具组合。
- `packages/pi-codex-conversion/src/adapter/code-mode/nested-tool-adapter.ts:144`：核心适配工具默认 `deferLoading: false`；`packages/pi-codex-conversion/src/adapter/code-mode/pi-tools.ts:30`：普通 Pi 桥接工具明确延迟。
- `packages/pi-codex-conversion/src/index.ts:17`、`packages/pi-codex-conversion/src/tools/apply-patch/tool.ts:167`：公开工厂与独立工具定义。
- `packages/pi-codex-conversion/src/tools/apply-patch/tool.ts:278`：公开的部分失败结果标记钩子。
- `packages/pi-codex-conversion/src/adapter/code-mode/toolkit-updates.ts:50`：PCC 简短分组目录及增量公告。
