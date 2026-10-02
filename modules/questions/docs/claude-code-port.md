# Claude Code port provenance

This historical extraction record is preserved from AskUserQuestion’s working-tree README.
It documents the origin of the prompt/schema/result conventions; it is not an installation
or validation procedure for this workspace. No Claude binary was read during migration.

## 逆向工程记录

Claude Code 2.1.259 是 Bun 单文件可执行程序（207 MB ELF），源码以 `$bunfs/root/chunk-*.js`
内嵌在二进制中（minified）。用 `grep -abo` 定位偏移，再用 `dd` 截取窗口即可读出原文：

```bash
BIN=~/.local/share/claude/versions/2.1.259
grep -abo "AskUserQuestion" "$BIN" | head        # 48 处
grep -abo "multiSelect"     "$BIN" | head        # 93 处

# 工具提示词定义（vwn）
dd if="$BIN" bs=1 skip=180975876 count=4000 2>/dev/null

# 输入/输出 Schema 与结果映射（约 185.56 MB 处）
dd if="$BIN" bs=1 skip=185545000 count=61000 2>/dev/null | strings -n 3
```

提取到的关键信息：

| 内容 | 证据 |
| --- | --- |
| 工具名与 header 上限 | `var Ji = "AskUserQuestion", Unr = 12;` |
| 提示词原文 | `Use this tool only when you are blocked on a decision that is genuinely the user's to make…` 以及 `Reserve this for decisions where the user's answer changes what you do next…` |
| 输入 Schema | `questions` 1-4、每题 `options` 2-4、`label` 题内唯一、`description` 必填 |
| 隐藏输入字段 | CC 的 Schema 还含 `answers` / `annotations` / `metadata`（权限组件回填 `updatedInput`）；pi 没有这一层，故未暴露 |
| 输出 Schema | `answers` 以问题文本为键；`response`、`annotations`、`afkTimeoutMs` |
| 结果文本映射 | `mapToolResultToToolResultBlockParam` 的分支逻辑 |
| UI 字符串 | `Review your answers`、`You have not answered all questions.`、`Type something.`、`. Chat about this`、`press n to add notes`、`auto-continue in Ns · any key to stay`、`CLAUDE_AFK_TIMEOUT_MS` 等 |

