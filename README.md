# pi-Serraly

私有本地 Pi package：六个可独立启停的入口，一个维护仓库。
支持基线为 **Pi 0.99.2 / Node ≥22.19**。不发布 npm，不提供总 factory 再次注册能力。

## 六个入口

| 能力 | 运行入口 | 使用与契约 |
| --- | --- | --- |
| UI | `dist/pi-ui/index.js` | [工具卡、Thinking、shell、`/ccstyle`、`/context`](modules/ui/README.md) |
| 提问 | `dist/pi-ask-user-question/index.js` | [`AskUserQuestion`、对话框、AFK](modules/questions/README.md) |
| 循环 | `dist/pi-loop/index.js` | [`/loop`、内存任务和忙闲调度](modules/loop/README.md) |
| 基础工具 | `dist/pi-tools/index.js` | [`apply_patch` 与 codemode 专用的 `grep`/`find`/`ls`](modules/tools/README.md) |
| 后台 shell | `dist/pi-background-shell/index.js` | [`bg_*`、任务 UI、通知和同进程 reload](modules/background-shell/README.md) |
| 文档解析 | `dist/pi-docparser/index.js` | [`document_*`、native worker、doctor](modules/docparser/README.md) |

根 `pi.extensions` 只声明以上六入口，安装后可在 `pi config` 分别启停。
docparser companion skill 作为来源保留，但**不自动启用**；其他 skills、
prompts、themes 和 npm 扩展不属于本仓库。

## 开发

```sh
npm ci --ignore-scripts --include=optional --legacy-peer-deps
npm run verify
```

验证使用临时 HOME/agent/cwd、合成会话、离线脚本化 provider 和本地 fixture，
不读取真实 auth/session/settings，也不发送真实模型请求。
命令、测试层级和 release 流程见[开发指南](docs/development.md)。

## 运行与安全边界

源码工作区的 Pi 依赖只用于开发测试。**不要 `pi install .`，不要把源码根或开发
`dist` 加入真实 settings。** 正式包由 release 工具准备在：

```text
~/.local/share/pi-Serraly/releases/<version>/
```

该目录只含运行 manifest、锁定运行依赖、dist 和许可，没有物理 Pi host 副本或
workspace 链接。更新时发布新的版本目录并切换引用，不覆写正在使用的目录。

## 维护导航

- [跨模块职责、依赖和产物结构](docs/architecture.md)
- [开发、测试和 release 准备](docs/development.md)
- 各模块 README 与 `LICENSE`/`UPSTREAM.md`：单能力用法及继承代码的来源与许可

旧源码仓库只作历史参考，不再用于常规更新。模块保留各自许可证，
私有组织不将继承代码重新标记为统一的自有许可证。
