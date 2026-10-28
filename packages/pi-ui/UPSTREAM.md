# 来源

本仓精简分支 `c3e3585232ca4b9ae709fe980d78ff345baceb0e` 的 `extensions/pi-ui` 是功能与视觉基线。当前包抽取 Thinking、Footer、活动完成提示（原 state/activity-completion.ts）、置顶消息和必要配置；适配 Pi 1.4.0，独立实现有界状态和可清理生命周期，不迁入工具 renderer、Markdown 修改、消息摘要、旧私有框架或共享库。

Thinking 的既有设计来自 MIT 的 pi-cc-extensions / pi-compact-thinking，Footer 与界面契约来自 claude-style-tools。保留原声明于 licenses/，新代码 MIT。完整 howaboua 八包来源由根 UPSTREAM 索引，不将此包归入它们。

包可独立登记或由本地 pi-extensions 聚合包转发。types/index.d.ts 提供公开工厂声明，运行仍使用保留 Pi loader 绑定的 dist/index.ts，不改变展示行为。
