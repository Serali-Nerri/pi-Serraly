# pi-Serraly

私有本地 Pi package：七个可独立启停的入口，一个维护仓库。
支持基线为 **Pi 1.0.0 / Node ≥22.19**。不发布 npm，不提供总 factory 再次注册能力。

## 七个入口

| 能力 | 运行入口 | 使用与契约 |
| --- | --- | --- |
| UI | `dist/pi-ui/index.js` | [工具卡、Thinking、shell、`/ccstyle`、`/context`](modules/ui/README.md) |
| 提问 | `dist/pi-ask-user-question/index.js` | [`AskUserQuestion`、对话框、AFK](modules/questions/README.md) |
| 循环 | `dist/pi-loop/index.js` | [`/loop`、内存任务和忙闲调度](modules/loop/README.md) |
| 基础工具 | `dist/pi-tools/index.js` | [`apply_patch` 与 codemode 专用的 `grep`/`find`/`ls`](modules/tools/README.md) |
| 后台 shell | `dist/pi-background-shell/index.js` | [`bg_*`、任务 UI、通知和同进程 reload](modules/background-shell/README.md) |
| 外部目录 | `dist/pi-add-dir/index.js` | [`/dir-add`、`/dir-ls`、外部指令与 skills](modules/add-dir/README.md) |
| 子代理 | `dist/pi-subagents/index.js` | [`Agent`、`StopAgent`、`AgentStatus`、`/agents` 与独立原生 SDK 会话](modules/subagents/README.md) |

根 `pi.extensions` 只声明以上七入口，安装后可在 `pi config` 分别启停。
本仓库不声明 skills、prompts 或 themes；外部 npm 扩展也不属于本仓库。同包发布
不意味着子代理自动加载所有入口；子代理默认能力与配置见其模块文档。

Pi 默认使用 fullscreen；需要终端原生滚动历史时，可显式设置
`"tuiMode": "regular"` 或使用 `--tui-mode regular`。

## 开发

```sh
npm ci --ignore-scripts --include=optional --legacy-peer-deps
npm run verify
```

验证使用临时 HOME/agent/cwd、合成会话、离线脚本化 provider 和本地 fixture，
不读取真实 auth/session/settings，也不发送真实模型请求。
命令、测试层级、release 和更新/回滚流程见[开发指南](docs/development.md)。
真实配置切换须另行授权。

## 运行与安全边界

源码工作区的 Pi 依赖只用于开发测试。**不要 `pi install .`，不要把源码根或开发
`dist` 加入真实 settings。** 正式包由 release 工具准备在：

```text
~/.local/share/pi-Serraly/releases/<version>/
```

该目录只含运行 manifest、dist 和许可，没有运行依赖安装、lock、`node_modules`、
物理 Pi host 副本或 workspace 链接。已安装的 Pi 通过 settings `packages` 引用 release 绝对路径；
更新时发布新的版本目录并切换引用，不覆写正在使用的目录。

## 维护导航

- [跨模块职责、依赖和产物结构](docs/architecture.md)
- [开发、测试和 release 准备](docs/development.md)
- 各模块 README 与 `LICENSE`/`UPSTREAM.md`：单能力用法及继承代码的来源与许可

旧源码仓库只作历史参考，不再用于常规更新。模块保留各自许可证，
私有组织不将继承代码重新标记为统一的自有许可证。
