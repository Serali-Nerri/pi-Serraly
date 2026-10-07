# pi-Serraly

私有本地 Pi package：七个可独立启停的扩展，一个维护仓库。
支持基线为 **Pi 1.0.4 / Node ≥22.19**。不发布 npm，不提供总 factory 再次注册能力。

## 七个入口

| 能力 | 运行入口 | 使用与契约 |
| --- | --- | --- |
| UI | `extensions/pi-ui/dist/pi-ui.js` | [工具卡、Thinking、shell、`/ccstyle`](extensions/pi-ui/README.md) |
| 提问 | `extensions/pi-ask-user-question/dist/pi-ask-user-question.js` | [`AskUserQuestion`、对话框、AFK](extensions/pi-ask-user-question/README.md) |
| 循环 | `extensions/pi-loop/dist/pi-loop.js` | [`/loop`、内存任务和忙闲调度](extensions/pi-loop/README.md) |
| 基础工具 | `extensions/pi-tools/dist/pi-tools.js` | [`apply_patch` 与 codemode 专用的 `grep`/`find`/`ls`](extensions/pi-tools/README.md) |
| 后台 shell | `extensions/pi-background-shell/dist/extensions/background-tasks.js` | [`bg_*`、任务 UI、通知和同进程 reload](extensions/pi-background-shell/README.md) |
| 外部目录 | `extensions/pi-add-dir/dist/pi-add-dir.js` | [`/dir-add`、`/dir-ls`、外部指令与 skills](extensions/pi-add-dir/README.md) |
| 子代理 | `extensions/pi-subagents/dist/pi-subagents.js` | [`Agent`、`StopAgent`、`AgentStatus`、`/agents` 与独立原生 SDK 会话](extensions/pi-subagents/README.md) |

每个扩展是独立的 private npm workspace 包，拥有自己的 manifest、构建、测试、许可
和版本；`packages/` 下的共享库只被这些扩展在构建期 bundle。根 `pi` 显式声明空
资源清单，安装 release 后才由聚合 manifest 声明以上七入口，可在 `pi config`
分别启停。本仓库不声明 skills、prompts 或 themes；外部 npm 扩展也不属于本仓库。
同包发布不意味着子代理自动加载所有入口；子代理默认能力与配置见其模块文档。

Pi 默认使用 fullscreen；需要终端原生滚动历史时，可显式设置
`"tuiMode": "regular"` 或使用 `--tui-mode regular`。

## 开发

```sh
npm ci --ignore-scripts --include=optional --legacy-peer-deps
npm run verify
```

`verify` 只构建一次（含产物校验），然后执行 check 和 test；后二者不隐式构建。
涉及编译产物的定向测试先显式构建受影响包，`pack:check` 可独立验证现有产物：

```sh
node scripts/test.mjs --package pi-loop
node scripts/test.mjs --suite integration
node scripts/test.mjs --package pi-subagents --list
```

验证使用临时 HOME/agent/cwd、合成会话、离线脚本化 provider 和本地 fixture，
不读取真实 auth/session/settings，也不发送真实模型请求。
根入口在 Node 低于 **22.19** 时直接失败；CI 只在 Node **24.12.0** 上运行一轮
`npm run verify`，本地使用实际 managed Pi 的运行时，不重复执行 Node 矩阵。
安装阶段之外保持网络拒绝。
命令、测试层级、release 和更新/回滚流程见[开发指南](docs/development.md)。
真实配置切换须另行授权。

## 运行与安全边界

源码工作区的 Pi 依赖只用于开发测试。**不要 `pi install .`，不要把源码根或开发
`dist` 加入真实 settings。** 正式包由 release 工具准备在：

```text
~/.local/share/pi-Serraly/releases/<version>/
```

该目录由聚合 manifest、`release.json` 和 `extensions/<包名>/` 下的密封 payload
组成，没有运行依赖安装、lock、`node_modules`、物理 Pi host 副本或 workspace
链接。已安装的 Pi 通过 settings `packages` 引用 release 绝对路径；
更新时发布新的版本目录并切换引用，不覆写正在使用的目录。

## 维护导航

- [跨模块职责、依赖和产物结构](docs/architecture.md)
- [开发、测试和 release 准备](docs/development.md)
- [上游与许可汇总](UPSTREAM.md)：仍保留外部上游的扩展及其固定来源
- 各包 README 与 `LICENSE`：单能力用法及许可

旧源码仓库只作历史参考，不再用于常规更新。模块保留各自许可证，
私有组织不将继承代码重新标记为统一的自有许可证。
