# pi-tools

在 Pi 中注册四个工具：独立的 **`apply_patch`**，以及同名替换内置 `grep`、`find`、`ls` 的 **codemode 工具**。不改变工具选择策略，不注册 UI renderer。

`apply_patch` 的 `exposure: "direct"`，命名空间为 `patches`；宿主默认从首轮激活该工具，其他工具或 codemode 也可在激活时调用它。

三个搜索工具复用 `@earendil-works/pi-coding-agent` 公共 `createGrepToolDefinition`/`createFindToolDefinition`/`createLsToolDefinition` 的 name、参数、执行与结果契约，覆盖同名内置定义，`exposure: "codemode"`，共用命名空间 `filesystem`，并去掉宿主 renderer（交互模式仍按名称补回内置卡片）。它们注册时不会进入活动工具集：默认不声明给模型，但可通过启用 `codemode` 后的脚本（`tools.grep`、`tools.find`、`tools.ls`）调用；显式激活（如 `defaultTools`）同样有效。

`codemode` 工具默认不启用；建议配置 `{"defaultTools": ["+codemode"]}`。`--tools codemode` 是注册表 allowlist，会同时过滤掉其他扩展工具，不能用来“只启用 codemode”。

## grep、find、ls

三者的参数、默认限制、忽略规则和截断行为与 Pi 1.0.4 的内置实现一致，执行使用调用时的 `ctx.cwd`：

| 工具 | 参数 | 默认限制 |
| --- | --- | --- |
| `grep` | `pattern` 必填；`path`、`glob`、`ignoreCase`、`literal`、`context`、`limit` 可选 | 100 个匹配、50 KiB，长行截断到 500 字符 |
| `find` | `pattern` 必填；`path`、`limit` 可选 | 1000 个结果、50 KiB |
| `ls` | `path`、`limit` 可选 | 500 个条目、50 KiB，含 dotfiles，目录带 `/` |

`grep` 依赖 ripgrep（`rg`），`find` 依赖 fd；缺失时宿主按 Pi 的既有策略查找或下载。三者没有 `outputSchema`，codemode 脚本获得文本输出而不是结构化对象。

`apply_patch` 支持 UTF-8 文本文件的新增、修改、删除和移动，以及一份补丁的多个文件操作。保留已有文件的 BOM、各行换行符和普通权限位。支持 grammar 的模型/接口接收 apply_patch 的 Lark 语法；其他接口使用相同工具的 JSON 参数。

开发与测试基线为 Pi **1.0.4**、TypeBox **1.3.27**、Node **≥22.19**。
`apply_patch` 不启动后台进程、不执行 shell 命令、不发送网络请求或遥测。

## 模型可见工具定义

定义集中在 `src/tool.ts` 的 `createApplyPatchTool()`；入口 `src/index.ts` 注册四个工具，三个搜索工具直接复用宿主工厂并覆写 exposure/namespace。

- 模型调用名 `name`：`apply_patch`。
- 界面标签 `label`：`apply_patch`（标签不是另一个工具）。
- 完整 `description` 描述补丁语法、路径及失败边界，见 `src/tool.ts`。

### 参数 schema

Pi 内部及普通 JSON 工具调用使用以下 JSON Schema；只有 `input` 必填，没有其他参数：

```json
{
  "type": "object",
  "properties": {
    "input": {
      "type": "string",
      "description": "The complete *** Begin Patch ... *** End Patch text"
    }
  },
  "required": ["input"],
  "additionalProperties": false
}
```

同时声明 `constrainedSampling: { type: "grammar", variants: { openai_lark: PATCH_GRAMMAR } }`，语法源为 `src/grammar.ts`。支持原生 grammar 的接口会将其转换为 custom/grammar tool，模型直接生成补丁文本，而不是上述 JSON 对象；执行端仍得到统一的 `{ input: string }`。不支持时回退 JSON，工具名与执行逻辑不变。

### promptSnippet

```text
Apply patches to add, update, delete, or move files
```

### promptGuidelines

```text
Use apply_patch for file changes; inspect existing text before constructing update chunks.
apply_patch: @@ context anchors are text, not line numbers. Keep chunks in source order and include enough context to target the intended occurrence.
```

普通 Pi 在工具激活时加入这些提示元数据。本扩展不改写整个 system prompt，也不要求禁用或替换 `edit/write`。

在默认工具配置下，`apply_patch` 的完整工具定义及上述 snippet/guidelines 从首轮请求开始提供给模型。

## 补丁格式

```diff
*** Begin Patch
*** Add File: src/message.ts
+export const message = "hello";
*** Update File: src/main.ts
@@ function greet() {
-  return "old";
+  return "hello";
*** Delete File: obsolete.txt
*** End Patch
```

移动文件在 `Update File` 后紧接 `Move to`，并包含至少一个有效修改/上下文块：

```diff
*** Begin Patch
*** Update File: old.txt
*** Move to: docs/new.txt
@@
-old content
+new content
*** End Patch
```

普通 JSON 工具调用形式：

```json
{
  "input": "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch"
}
```

原生 grammar/custom tool 由 Pi 根据模型能力自动选择，此时模型直接发送补丁文本。不要仅因为模型名称像 GPT 就给不支持 custom tools 的代理接口强行开启 grammar。

### 匹配规则

- `@@` 后可以是源码中的定位文本，**不是** unified diff 的数字行号。
- 块中的空格前缀是上下文，`-` 是删除，`+` 是新增；修改块按原文件顺序排列。
- 依次尝试精确匹配、忽略尾部空白、忽略两端空白、规范化部分 Unicode 标点。
- 同等匹配有多个位置时，选择当前搜索位置之后的第一个；请提供足够上下文。
- 只有 `+` 行、没有旧行的更新块会追加到文件末尾。
- 实际改变行内容的非空更新结果会补齐末尾换行；纯删除可以得到空文件。新增内容使用 LF。
- no-op 更新仍校验上下文、定位及块顺序，但保留原始字节（包括 BOM、混合换行符和缺失的末尾换行）。纯上下文块、替换后与实际匹配内容相同的 `-x/+x` 不会触发重写；若模糊匹配到的原文不同于 `+` 行，仍属于实际修改。
- 本工具不是 `git apply`：不接受 `---`/`+++` 文件头，不接受二进制 diff。

## 边界与失败行为

**这是文件修改工具，不是权限沙箱。** 路径相对于调用时的 `ctx.cwd`；允许绝对路径和 `../`，不展开 shell 的 `~`。目录符号链接会解析到真实目录，可能指向工作区之外。

- `Add File` 和 `Move to` **可以覆盖已存在的普通文本文件**。操作前应先阅读目标文件。
- 拒绝文件级符号链接、硬链接、目录、NUL/二进制内容和无效 UTF-8；如需修改链接目标，请明确指定真实目标路径。
- 完整补丁先做路径、文本及上下文校验；校验失败不写文件。
- 结果按最终文件状态报告实际变更，不把 no-op 列为 `M`；整份补丁无实际变更时返回 `No files were modified.`，`details.changes` 为空。仅移动路径仍是变更，移动到同一规范路径且内容不变则是 no-op。
- 同一文件的多个操作合并为最终结果：`A` 表示新建、`M` 表示修改已有文件、`D` 表示删除；来源确实删除且目标仍存在的有效直接移动保留 `M 目标 (from 来源)`。目标被后续 Add、Delete/重建或另一 Move 覆盖后，旧移动来源失效；普通 Update 保留有效关系。临时创建后删除、修改后恢复等抵消的操作不列出。
- 使用 Pi 的每文件修改队列；锁覆盖读取、计算与提交，多个文件按固定顺序加锁。该队列不协调其他编辑器或独立进程，也不构成防御恶意文件系统竞态的沙箱。
- 单个文件使用同目录临时文件加 rename 替换，保留普通权限位；不承诺保留 inode、所有权、ACL 或扩展属性。
- 多文件操作**不是事务**：I/O 错误或提交期间取消，可能留下已经完成的修改。错误会列出已完成文件，不自动回滚。移动时先写目标，再删来源，避免目标写入失败就丢掉来源。
- 不支持同一补丁把一个文件变成目录并在其下新增文件。

为避免意外大输入：补丁上限 1 MiB；单个输入/输出文件 10 MiB；目标文件原始内容合计 32 MiB；最多 128 个路径；模型可见结果文本最多 200 行/16 KiB。展示用 details 另有下述预算。无后台进程、网络请求和遥测。

## 用户可见 diff 与 ccstyle

本扩展负责执行和准确数据，ccstyle 负责可选的专用展示；两个扩展不互相依赖或注册对方工具。本扩展不添加 `renderCall`/`renderResult`。未启用支持 v1 契约的 ccstyle 时仍可正常使用，只显示原生文字摘要；旧版 ccstyle 可能将 details 当作通用元数据展开。

文件锁内捕获本次操作实际使用的原始/最终内容，全部提交成功后释放锁，再生成报告。显示不会通过重读磁盘或重新解释输入补丁来推测变化。报告生成失败、达到预算或报告期间取消，只降级 diff 展示，不把已提交的文件操作改报失败。

### details v1 契约

普通成功结果采用以下结构；参数 schema 和模型可见 `content` 不变：

```text
{
  format: "apply_patch.v1",
  changes: [{ kind, path, moveFrom?, contentChanged?, views: [...] }],
  reportUnavailable?: "diff-error"
}
```

- `kind/path/moveFrom` 延续原有含义；no-op 精确返回 `{ format: "apply_patch.v1", changes: [] }`。
- 移动变更可带可选布尔 `contentChanged`（仅 `moveFrom` 存在时给出）：直接比较锁内捕获的来源原始字节与目标最终字节，字节格式变化（BOM、末尾换行、CRLF 等）也算改写；两侧快照无法确定来源或最终内容时省略，报告为 `reportUnavailable` 时不做任何声明。旧版消费者忽略该新增可选字段即可。
- 每个 `views` 条目包含 `role`、`before/after` 文件事实、`added/removed`、可选 `diff`、`availability`、可选 `reason/diffTotalLines`、`lineEndingsChanged`。
- 文件事实为 `{ exists, bytes, lines, bom, endings: { lf, crlf, cr }, finalNewline }`。字节数来自原始 UTF-8；逻辑行数不将末尾换行计为额外一行；不存在与空文件通过 `exists` 区分。不保存完整源文件字符串。
- `diff` 使用 Pi 内置 edit 的显示格式（`+17 text`、`-17 text`、` 17 text`），不是输入补丁语法，也不是带 `@@` 的 unified patch。显示副本统一行终止符；BOM、末尾换行及换行分布变化由事实/附注表达，不改变磁盘字节。
- `added/removed` 为完整逻辑行 diff 的统计，先统计再截断；未计算为 `null`，不能当成 0。`availability` 为 `complete`、`truncated` 或 `omitted`；`reason` 可为 `work-limit`、`result-limit`、`diff-error` 或 `cancelled`；`diffTotalLines` 未知则省略。
- 整体报告不可用时保留基础 changes，每项 `views: []`，顶层 `reportUnavailable: "diff-error"`，仍是执行成功而非文件操作失败。
- 消费者必须同时检查工具名 `apply_patch`、format 及字段类型/上限，忽略兼容性新增字段；遇到旧版、未知格式或不合法数据退回摘要/通用展示，不猜测实际变更。

普通增删改是一块 `file` 视图；新增/删除比较不存在与内容，覆盖已有文件比较真实前后内容。移动到原本不存在的目标是一块 `move`（来源原始内容 → 目标最终内容），纯移动不制造整文件增删。移动到已存在的目标使用两块：`source-delete` 展示来源移除，`destination` 展示目标真实前后内容，避免藏掉被覆盖的旧目标；目标字节相同时明确表示目标未改写。展示统计按这些视图计算，来源只计一次，有未知项时不得声称总统计完整。每次移动变更另带可选 `contentChanged`（仅 `moveFrom` 存在时）直接比较来源原始字节与目标最终字节，用于区分纯移动与移动改写；`source-delete`/`destination` 两块视图比较基准不同，不能单独用来推断移动是否改写，缺少该字段时不得猜测。

details 随 Pi 会话保存，但不作为工具 `content` 发给模型。仅保留有界 diff，而非完整文件快照；UI 的“展开”只能显示已保存的数据，必须保留截断/省略提示，不能事后读取当前文件补全历史报告。

### 报告资源与错误边界

- 每个视图最多保留 200 行/16 KiB diff，整个结果合计最多 600 行/64 KiB diff。保留完整文件列表；路径/事实元数据另受既有路径数和补丁输入限制，因此这不是整个 JSON 的 64 KiB 上限。
- 新增/删除线性计数并限量输出；普通更新保留规范化两侧合计 ≤2 MiB、逻辑行合计 ≤50,000 的输入保护。**不再按首尾修改之间的跨度拒绝计算**：600 行文件中两处远距离替换是 2 次新增 + 2 次删除，不把中间未变内容计入编辑距离。
- 更新通过 jsdiff `structuredPatch` 的 `maxEditLength`/`timeout` 在搜索过程中限制工作量；每个视图最多搜索 1,000 次行增删，整份报告编辑预算 4,000。成功按实际增删计费；预算中止或异常的搜索扣除本次分配的额度，避免反复免费重试。只有一次差分搜索，行号、上下文和统计直接从其结果生成，不再调用无预算的格式化助手重算 diff。
- 单次搜索时间预算最多 250 ms，整份报告从开始计 1,000 ms 截止时间，后续搜索使用剩余时间。库在搜索迭代间协作检查时间，**不是严格实时抢占**：分词、格式化与单次迭代可能跨过截止点，因此同时保留输入大小/行数和编辑距离保护。
- 计算与显示限制分开：输入或搜索超限时保留文件事实，以 `work-limit` 标记未知统计；已算出但预览过长时保留完整统计，以 `result-limit` 标记截断。任何超限只影响可选报告，不拒绝或改报已经成功提交的文件操作。超长首行不会按半行/半个 UTF-8 字符切断。
- 工具执行失败时抛出的错误不携带这份结构化 details。预检失败、部分提交、取消会返回明确错误诊断；ccstyle 可展开已完成操作文本，但本版不提供失败态逐文件 diff，也不把输入补丁画成已成功的变更。

