# 来源与本地契约

参考 [openai/codex](https://github.com/openai/codex)，固定提交 `69231e119bfca0b14453515e97d99688ce1c47c9`。

- `codex-rs/context-fragments/src/recap_prompt.rs`：改编提示词与 32 KiB 预算。
- `codex-rs/tui/src/app/recap_history.rs`：移植文本选择、最近 8 个 exchange、pending request 与 UTF-8 excerpt 思路。
- `codex-rs/tui/src/app/recap.rs`：参考门控、空闲计时与失败重试。

Pi 接线、配置、controller、终端输入和临时 widget 为本仓实现。与 Codex 的主要差异：使用公开 Pi ModelRegistry，JSON 由提示词约束并严格解析，不使用 provider schema；默认自动开启；按当前 branch 的用户 exchange 计数；独立 TUI widget，不创建临时 thread 或持久消息，因此不移植 Codex app-server 的云端会话门控与临时 thread 路由。原包版本从 `0.1.0` 开始，不沿用 Codex 版本。

更新时对比并合并这三个来源文件，保留 Pi 生命周期/计数/展示契约；不得覆写本地适配。Apache-2.0 条款及归属保留在包内。
