# 来源

本仓精简分支 `c3e3585232ca4b9ae709fe980d78ff345baceb0e` 的 `extensions/pi-ui` 是功能与视觉基线。当前包抽取 Thinking、Footer、活动完成提示（原 state/activity-completion.ts）、置顶消息和必要配置；适配 Pi 1.5.0，独立实现有界状态和可清理生命周期，不迁入工具 renderer、Markdown 修改、消息摘要、旧私有框架或共享库。

Thinking 的既有设计来自 MIT 的 pi-cc-extensions / pi-compact-thinking，Footer 与界面契约来自 claude-style-tools。保留原声明于 licenses/，新代码 MIT。完整 howaboua 包来源由根 UPSTREAM 索引，不将此包归入它们。

包可独立登记或由本地 pi-extensions 聚合包转发。types/index.d.ts 提供公开工厂声明，运行仍使用保留 Pi loader 绑定的 dist/index.ts，不改变展示行为。

移除 Footer 的活动行，回合末尾的净工作耗时提示保持独立；当前展示契约见 [README.md](README.md#展示)。

## Git Footer

Git 状态读取、计数规则、配色、显示顺序和自动图标模式来自 [OldSuns/pi-open-tui](https://github.com/OldSuns/pi-open-tui)，版本 `0.4.5`，固定提交 `d1b0cb423e71022094d9b6628583883dc4376a01` 的 `extensions/open-tui/git.ts`、`footer.ts`、`icons.ts` 和 `utils.ts`。MIT 许可保留在 [licenses/pi-open-tui-LICENSE](licenses/pi-open-tui-LICENSE)；上游注明 Git porcelain 解析借鉴 [pi-zentui](https://github.com/lmilojevicc/pi-zentui)。

只迁入 Git 段，不加载 pi-open-tui 扩展、配置、其他 Footer 段或依赖。保留上游默认的分支/状态和 detached HEAD 提交号，不启用可选标签；本地把分支截断改为终端列宽，并适配现有清理生命周期：可取消的只读异步 Git 查询、固定解析 locale、工具/回合结束刷新，render 只读快照。替换旧宿主 `getGitBranch()` 文本，仍使用公开分支通知。使用规则见 [README.md](README.md#git-状态)。
