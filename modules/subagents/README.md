# pi-subagents

独立入口 `dist/pi-subagents/index.js`，在 Pi 中注册 **`Agent`、`StopAgent`、
`AgentStatus`** 和 **`/agents`**。三工具使用宿主默认的 direct exposure，注册后
active；UI 模块只管展示，不执行或代管子代理。支持基线是 Pi **1.0.0**、
TypeBox **1.3.27**、Node **≥22.19**。来源与许可见 [UPSTREAM.md](UPSTREAM.md)
及 [LICENSE](LICENSE)；构建、隔离和 release/替换流程见[开发指南](../../docs/development.md)。

## 使用

`Agent` 前台调用返回结果和统计；后台调用立即返回 ID，完成后通知父会话。
`/agents` 可手工 spawn、查看会话、steer 运行中任务、continue 已结束任务、Stop、
Clear、设置模型/并发/提示词/widget。widget 和 viewer 仅用于 TUI，不在
print/JSON/RPC 创建终端组件或 UI bridge。

| 工具 | 参数 |
| --- | --- |
| `Agent` | `prompt` 必填；`description`、`agent`、`run_in_background`、`worktree_path` 可选 |
| `StopAgent` | `agent_id` 必填，停止运行中或排队中的任务 |
| `AgentStatus` | 无参数；列出任务并提醒不要轮询，完成通知自动送达 |

`agent` 默认 `general-purpose`，名称精确匹配优先，其后允许唯一的大小写不敏感
匹配。`model`、thinking、turn/output cap 从配置解析，不是模型可传的工具参数。
严格 schema 模式 `agentToolStrictMode: true` 让可选参数以 nullable 字段表示，
要求传全字段；默认关闭。子代理不能再调用三个 Agent 控制工具。

## 配置位置与优先级

所有用户级路径基于 Pi `getAgentDir()`，支持 `PI_CODING_AGENT_DIR`，默认是
`~/.pi/agent`，不缓存另一个 HOME 的目录：

- `<agentDir>/subagents-lite.json`：全局配置。
- `<agentDir>/subagents-lite-prompt.md`：custom 系统提示词。
- `<agentDir>/agents/*.md`：用户 agent 文件。
- 可信目标的 `.agents/agents/*.md`、`.pi/agents/*.md`：共享和项目 agent 文件。
- 可信项目 `.pi/subagents-lite.json`：只覆写模型家族（含 default thinking/turn
  limit、每类型模型）和 concurrency，不覆写 widget、watchdog 或能力选择策略。

agent 文件逐字段优先级为 **项目 > 共享 > 用户 > 内置**；必须有 `name`，Markdown
正文是 agent 指令。frontmatter 支持扁平字段、逗号/内联列表和逐行数组，不支持
任意嵌套 YAML。

模型优先级为 session 每类型 > session default > 项目/全局每类型 > 项目/全局
default > frontmatter > 父模型。配置中 null 表示不覆写。thinking 优先使用
frontmatter，其后是目标 Pi 的 per-model thinking 和模块 defaultThinking，
未设置时沿用父级。常用全局配置示例：

```json
{
  "agent": {
    "default": null,
    "loadExtensionsImplicitly": false,
    "loadSkillsImplicitly": true,
    "systemPromptMode": "replace",
    "includeContextFiles": true,
    "outputTranscript": false,
    "finishedRetentionMinutes": 1,
    "toolTimeoutMinutes": 45,
    "idleTimeoutMinutes": 45
  },
  "concurrency": { "default": 4 }
}
```

并发以模型为单位；`concurrency.models["provider/model-id"]` 高于
`providers["provider"]`，高于 `default`。超额任务排队；这不是保留会话总数上限。

## 扩展选择与原生能力

默认 `loadExtensionsImplicitly: false`：

- 无显式 `extensions` 的 **general-purpose** 只选择 `builtin:codemode`、
  `builtin:tool-search`、`builtin:mcp`。
- 其他自定义 agent 未设置 extensions 时不加载扩展；内置 **Explore** 明确为
  `extensions: false`。用户同名文件可显式覆写内置 profile。
- `extensions: false` 或 `[]` 选择零扩展，不会被默认值填回。
- 数组只选择列出的已启用候选；`extensions: true` 或明确全局 implicit=true
  才继承所有合格的已启用扩展。模块自身和旧 subagents-lite 入口始终排除。
- Pi 的 settings 禁用优先于 agent 选择：如 `-builtin:mcp` 不会因 agent 列表
  含 mcp 而重新启用。数组 whitelist 优先于 `exclude_extensions`；在继承模式
  可用 exclude 列表减去候选。

使用宿主 PackageManager 发现候选，在执行工厂**之前**选择。包名可选择整个包，
`pi-tools` 这样的叶名称只选该入口，候选绝对路径只选那一个文件；原生身份使用
规范 `builtin:` 名称。未知请求有诊断，不退回全加载。数组不是新的 npm/git
安装语法，子代理不会为了选择而安装缺失包。

子会话显式提供 Pi 的三个原生工厂，并保持目标 settings 的 `codemode.mode`
（on/only）、inlineBudget、MCP exposure/toolExposure、资源和重连行为。
**扩展叫 `builtin:tool-search`，工具叫 `tool_search`**。选择了扩展不代表强制
激活该工具；例如 Pi settings `"defaultTools": ["+codemode", "+tool_search"]`
保留其他默认工具并激活两者，MCP 原生 exposure 也可自动激活它们。

### 配置示例

下列片段是 agent Markdown 文件的 frontmatter，后面可加入正文指令。

**general-purpose native-only**（省略 extensions 时默认相同）：

```yaml
---
name: general-purpose
description: General task execution with native capabilities
extensions: [builtin:codemode, builtin:tool-search, builtin:mcp]
---
```

**仅 pi-tools 加原生能力**（先在 Pi 配置中启用该 release/入口）：

```yaml
---
name: patch-worker
description: Work with patches and native tools
extensions: [pi-tools, builtin:codemode, builtin:tool-search, builtin:mcp]
---
```

该选择不执行同包 UI、questions、loop 或其他兄弟入口的工厂。

**限定 Explore 工具**：

```yaml
---
name: Explore
description: Inspect files without edit/write tools
tools: [read, bash, grep, find]
extensions: false
skills: false
---
Use bash only for inspection; do not modify files or system state.
```

**完全不加载扩展**（Pi 内置工具仍按 tools 策略存在）：

```yaml
---
name: builtin-only
description: Use only selected built-in tools
tools: [read, grep, find]
extensions: false
---
```

**精确排除动态 MCP 工具**：

```yaml
---
name: docs-worker
description: Read documentation, not delete it
extensions: [builtin:codemode, builtin:tool-search, builtin:mcp]
exclude_tools: [mcp__docs__delete_page]
---
```

## 工具准入与安全边界

未设置 tools 或显式 `tools: true` 的继承模式不把启动时 registry 快照当白名单，
延迟注册的 MCP 工具可按原生 exposure 使用。`tools: false` 或空数组禁止所有
工具，包括 Pi 内置工具。工具数组是实际注册/调用准入，而不只是隐藏 active
schema。显式布尔值会替换低优先级文件的工具数组限制。精确 `exclude_tools`
交给 SDK，包含后续才注册的
exact MCP 名称。数组 whitelist 优先于普通 excludes；三个 Agent 控制工具无论
如何都不会授予子会话。inactive 工具不等于禁止调用：codemode/deferred 可能
通过嵌套工具调用到达，因此权限不能只靠 active 列表。

保留既有静态 `ext/*`、`ext/tool`、`ext/none` selectors：静态 `ext/*` 按已选择
扩展的工具展开，`ext/none` 只表示承认该扩展而不授予工具。继承模式的第三方
`exclude_tools: [ext/*]` 还按最新工具来源阻断延迟调用；它们的动态元数据可能
仍在发现列表中，不能承诺宿主未提供的 wildcard 元数据隐藏。
**不支持动态 MCP wildcard 授权**，如 `mcp/*`、`mcp__docs__*` 或
`builtin:mcp/*`；无法安全表达时直接报错。使用 exact `mcp__<server>__<tool>`
名称，或禁用 builtin:mcp。Pi `mcp.json` 自身的 toolExposure pattern 是宿主
exposure 配置，不是这里的子代理授权 DSL。

内置 Explore 不注册 edit/write，默认不加载间接扩展工具；但保留 bash，
**不是操作系统级只读沙箱**。所有扩展和 bash 仍具有 Pi 进程的 OS 权限；
选择与工具准入不能把不可信代码变成可信代码。

`worktree_path` 可指向任何磁盘上的 git 仓库目录，不限父仓库的 worktree。
省略路径继承父可信状态；同仓库不会自动把不可信父项目升级为可信。
目标显式 trust 决策优先，跨仓库未决定时按用户级 defaultProjectTrust 判定。
不可信目标忽略受保护的项目 settings/extensions/skills/MCP，用户层仍生效；
AGENTS.md 按 Pi context 合同处理，不宣称所有目标文本都被隔绝。

认证由父交互 Pi/原生 MCP 配置完成，子会话使用宿主已有 credentials 和 agentDir，
不复制密钥到 prompt/result，不共享父工具闭包或 MCP 客户端。
子代理**不进行交互式 OAuth 登录**；需要登录时先回父交互环境完成，再使用
宿主重连或新建子会话。

## 提示词、输出与资源保留

`systemPromptMode` 默认 `replace`：最小通用提示加 agent 指令。`inherit` 在 cwd 和
有效信任均不变时继承父提示词；跨 cwd 或信任边界时，重新构建目标 Pi 的
prompt/context/skills 并附加 agent 指令，不复制父项目受保护的 scaffold。
`custom` 使用 `<agentDir>/subagents-lite-prompt.md`。`include_context_files`、
`include_system_prompt` 可按 agent 覆写对应策略，custom 模式优先。
`skills` 选择 metadata，`preload_skills` 选择加载全文；后者有额外 token 成本。

frontmatter 可设置 `model`、`thinking`、`max_turns`、`max_tokens`、`hidden`、
`display_name`、`color`、`output_transcript`。turn limit 有 grace turns 后硬停止；
两类 watchdog 默认 45 分钟，0 禁用。开启 transcript 时写入
`<os.tmpdir()>/pi-agent-outputs/<agentId>.log`，可 tail；Clear 不删除历史输出文件。

每个子会话拥有独立会话状态、tool-search 激活、codemode store 和原生 MCP
连接。普通完成/Stop 保留 session，可 continue 而不重新连接；这些状态不传播
给父或其他子代理。`finishedRetentionMinutes` 只隐藏过期 widget 行，**不是
session TTL**。长会话中 retained MCP 连接/进程可增长，即使运行并发不高。

**Clear** 开始释放已结束任务的所有权；父 reload/quit/new/resume/fork 释放全部
子会话。关闭等待有限的初始化边界，发 session_shutdown 后 dispose，幂等处理
晚到连接；普通 Stop 不等于资源已关闭。移除显示行也不等于异步清理已完成。
任务在内存中维护，不提供后台任务跨进程恢复或共享 MCP 连接池。

## 替换旧安装

保持 `subagents-lite.json`、agent 文件和 custom prompt 的原命名。不要同时启用
旧 `npm:pi-subagents-lite` 与新入口。使用不可变版本化 release、备份 settings，
停止实例后显式切换；回滚恢复备份/旧已知版本，不覆写 release。
真实机器切换需单独授权，详见[操作流程](../../docs/development.md#子代理替换与回滚)。
