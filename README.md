# pi-Serraly — 第一阶段：pi-ui

私有本地 Pi 扩展工作区。当前实现将 `claude-style-tools` 与
`pi-session-ui` 按职责合并为一个 **pi-ui** 入口，基线为 **Pi 0.99.2**、
Node ≥22.19。

**当前阶段：UI 已通过用户验收。** 当前仅含 UI，其余五个模块留待第二阶段整理；
全局尚未切换，旧源码保持原状。

## 验证与预览

```sh
cd /home/thelya/Work/Scripts/pi-Serraly
npm ci --ignore-scripts --include=optional
npm run verify

node scripts/preview.mjs regular
node scripts/preview.mjs fullscreen

# 原生 read/write/edit 的临时文件、diff 和丰富 Markdown 样本
node scripts/preview.mjs regular rich
node scripts/preview.mjs fullscreen rich
```

预览使用临时 HOME/agent/cwd、合成数据、脚本化 provider 和网络阻断，
通过实际 Pi 0.99.2 loader 加载开发依赖树外的 ESM 产物。退出后删除沙箱。
详细操作和人工检查项见 [验收说明](docs/acceptance.md)。

`dist/` 是本工作区的构建输出。正式运行包将放在开发依赖树之外；
**不要执行 `pi install .` 或把源码根加入真实 settings**。

## 安装与更新

采用一个私有本地 Pi package，根 `pi.extensions` 显式声明各扩展入口；
安装一次，通过 `pi config` 分别启停。无需发布 npm 或逐个复制扩展目录。

源码在本仓库维护；运行包发布到
`~/.local/share/pi-Serraly/releases/<build-id>/`，包含完整 dist、许可及必要运行依赖，
不包含开发依赖或物理 Pi 宿主副本。发布完成后安装该版本目录，例如：

```sh
pi install /home/thelya/.local/share/pi-Serraly/releases/0.1.0
pi config
```

本地安装只记录目录引用，不复制文件或自动准备依赖。更新时验证并发布新版本，
受控切换包条目，保留旧版本回滚。首次切换须结束在途任务、退出相关 Pi 实例，
归档被替换的旧扩展，避免重复加载；当前 UI-only 试切换仅替换两项旧 UI。

## 保留的体验

- 完整欢迎面板、模型/目录/命令提示、footer 和其他扩展状态。
- Git 分支/修改统计、项目运行时/版本、有界异步查询。
- Claude 风格工具卡、相邻分组、compact 轮次摘要、文件/diff 卡和长内容预览。
- Thinking 摘要标题、预览、动画、耗时，以及全会话历史耗时恢复。
- 全屏鼠标展开/hover、正文选择与链接、共享文字预览。
- Skill、压缩、分支摘要卡；`/context` 六类归因与逐项查看。

UI 只改变展示。工具执行、schema、prompt、exposure、返回数据和错误语义保持原样；
工具自带 renderer 优先保留。真正的内置工具由 `sourceInfo` 判断，同名扩展覆盖
不会被当成内置工具接管。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/ccstyle`、`/ccstyle panel` | 打开五页设置面板 |
| `/ccstyle on` | Claude 风格工具/消息展示 |
| `/ccstyle compact` | 轮次摘要及可展开过程视图，文件工具保留专用卡 |
| `/ccstyle off` | 恢复工具/摘要原展示；保留 shell、Markdown 和独立 Thinking |
| `/ccstyle status` | 显示十二项有效设置 |
| `/context` | 独立上下文用量与六分类查看 |

## 十二项设置

继续使用 `$PI_CODING_AGENT_DIR/claude-style-tools.json`。启动只读；
用户显式保存时原子写入，保留未知字段、清理三个废弃字段。

| 字段 | 默认值 |
| --- | --- |
| `mode` | `"on"` |
| `excludeRenderers` | `[]` |
| `writePreviewLines` | `10` |
| `editPreviewLines` | `14` |
| `fileExpandedMaxLines` | `80` |
| `useSummaryTitlesAsThinkingTitle` | `true` |
| `previewLines` | `3` |
| `animationIntervalMs` | `90` |
| `inputClip` | `100` |
| `expandedInputMaxLines` | `5` |
| `expandedOutputMaxLines` | `10` |
| `enableContextCommand` | `true` |

这些预算只限制屏幕预览；展开仅查看已经返回或保存的数据，并保留工具截断提示。
已删除 `dimThinkingText`、`expandedPreviewMaxLines`、`scrollStepLines`，
旧 Task 专用展示和滚轮覆盖；滚轮完全遵循宿主 `fullscreenWheelScrollLines`。

## Markdown 与统计变化

保留五类 admonition、跨行链接区域修复及普通文本圈数字字体规避。
代码、既有链接目标、原始消息和会话数据保持原样。标准 Mermaid 和普通裸 URL
仍由 Pi 原生处理；仅对原生解析会吞入中文标点或全角括号的裸 URL 做显示层
边界兼容。旧非标准图表围栏按普通代码显示。
含 Markdown/LaTeX 特殊字符的少数 `www` 路径使用原生行内代码标签，保持 URL
字面文字与点击目标一致；引用块、列表内的既有引用定义和目标保持原样。

累计计费包含整个会话及所有独立 usage（包括 `cache_warm` 和未知 kind）。
独立 usage 不进入上下文分类或最近 assistant 缓存命中率。
上下文来源仅在 `/context` 中查看，footer 只显示占用数值；未知用 `?`，不显示为实测零。

## 维护

- [架构与兼容边界](docs/architecture.md)
- [来源、旧基线与行为变化](docs/provenance.md)
- [来源及完整许可证](modules/ui/licenses/README.md)
- 两阶段执行计划：`/home/thelya/.pi/plans/pi-ui-local-package.md`

开发宿主依赖精确锁定为 0.99.2，运行时保持 external/peer。宿主私有补丁集中在
`modules/ui/src/compat/`；升级 Pi 后重新执行验证和终端验收。
