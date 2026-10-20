# pi-tools

同名替换 Pi 内置 `grep`、`find`、`ls`，将它们注册为 **codemode 工具**。
不改变工具选择策略，不注册 UI renderer，也不注册 `apply_patch`。
其他扩展可以独立提供 `apply_patch`，无需停用这三个搜索工具。

三个搜索工具复用 `@earendil-works/pi-coding-agent` 公共
`createGrepToolDefinition` / `createFindToolDefinition` / `createLsToolDefinition`
的 name、参数、执行与结果契约，覆盖同名内置定义，`exposure: "codemode"`，
共用命名空间 `filesystem`，并去掉宿主 renderer（交互模式仍按名称补回内置卡片）。
它们默认不声明给模型，但可由 codemode 脚本通过 `tools.grep`、`tools.find`、
`tools.ls` 调用；显式激活（如 `defaultTools`）同样有效。

Pi 内置 `codemode` 默认不启用；可配置 `{"defaultTools": ["+codemode"]}`。
`--tools codemode` 是注册表 allowlist，会同时过滤其他扩展工具；
单次运行增量启用应使用 `pi --tools +codemode`。支持 Pi 工具桥接的其他代码
执行适配器也可调用这些工具。

## grep、find、ls

三者的参数、默认限制、忽略规则和截断行为与 Pi 1.3.0 的内置实现一致，
执行使用调用时的 `ctx.cwd`：

| 工具 | 参数 | 默认限制 |
| --- | --- | --- |
| `grep` | `pattern` 必填；`path`、`glob`、`ignoreCase`、`literal`、`context`、`limit` 可选 | 100 个匹配、50 KiB，长行截断到 500 字符 |
| `find` | `pattern` 必填；`path`、`limit` 可选 | 1000 个结果、50 KiB |
| `ls` | `path`、`limit` 可选 | 500 个条目、50 KiB，含 dotfiles，目录带 `/` |

`grep` 依赖 ripgrep（`rg`），`find` 依赖 fd；缺失时宿主按 Pi 的既有策略查找
或下载。三者没有 `outputSchema`，codemode 脚本获得文本输出而不是结构化对象。
本扩展不添加自己的 `promptSnippet` 或 `promptGuidelines`。

## 保留的补丁源码

`src/tool.ts` 的 `createApplyPatchTool()` 及其补丁算法、文件锁、预检、提交、
`apply_patch.v1` 报告和行为测试保留在源码中，但入口不导入、不注册它们，
也不把它们打入运行 bundle。它们不会向模型注入补丁工具定义或提示元数据。
UI 继续支持已有会话中的 `apply_patch.v1` 报告展示。

开发与测试基线为 Pi **1.3.0**、TypeBox **1.3.27**、Node **≥22.19**。
