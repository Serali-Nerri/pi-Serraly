# 仓库架构

## 六个维护边界

根 package 是资源清单和开发工作区，不是第七个 extension factory。
每个模块仅注册自己的能力；关闭一个入口不会通过总工厂间接重新启用它。

| 模块 | 拥有的资源 | 不拥有 |
| --- | --- | --- |
| `ui` | 展示生命周期、私有兼容补丁、shell、Markdown、Thinking、`/context` | 业务工具定义、执行和后台进程 |
| `questions` | `AskUserQuestion` schema、对话框、AFK、答案/results、专用 renderer | UI 总体刷新或其他 overlay |
| `loop` | `/loop` 解析、内存任务、忙闲调度、`local-loop` | UI scheduler、持久化恢复 |
| `tools` | `apply_patch` 补丁算法、文件锁、预检、提交、`apply_patch.v1` 报告；`grep`/`find`/`ls` 同名替换的 codemode 注册 | UI 历史 diff 重建 |
| `background-shell` | 进程/日志、dock、通知、状态、同进程 reload handoff | 跨进程恢复或 UI 工具卡接管 |
| `docparser` | 三个 document 工具、FIFO、worker、取消/超时/崩溃清理和预算 | OCR 服务安装或其他模块的生命周期 |

工具契约和详细算法留在各模块 README/子系统文档。UI 的私有宿主访问只在
`modules/ui/src/compat/`；其 host 事件只由 `src/lifecycle.ts` 注册。
UI 的共享 scheduler 不管理 loop 定时器、后台进程或文档 worker。

## 源码与运行树

```text
modules/              六个 private npm workspace；源码、测试、模块文档/许可
scripts/              工作区命令、构建和独立运行包
test/integration/     产物、实际 loader 和六入口共存
docs/                 跨模块设计与开发
dist/                 已验证的开发构建输出；不可直接用于真实安装
```

工作区统一 npm 锁定。开发宿主是精确 Pi 0.99.2、TypeBox 1.3.27。
宿主提供的包以 `peerDependencies: "*"` 声明并 external，不能作为正式包的
物理运行依赖。workspace 内的开发宿主副本不得延伸到正式运行树。

正式运行包位于开发依赖树之外的不可变 release 目录，只有运行 manifest、
投影自统一 npm lock 的运行锁、dist、许可及 LiteParse 运行依赖。
它没有 workspace 链接、开发工具、技能/模板/主题资源声明。

## 构建闭包

- UI、questions、loop、tools 是独立 ESM bundle；`diff@8.0.4` 打入补丁
  bundle 并携带其 BSD 文本。
- background-shell 用 tsc 编译完整 `extensions/` + `src/`，保留 lazy import；
  根入口只是同目录转发，不另行注册能力。
- docparser 的主入口 bundle，三个 worker/protocol/output `.mjs` 保持相对位置；
  LiteParse 2.10.1 及平台 optional binding 是外部运行依赖。
- 在非发现暂存目录构建，检查 emitted import 图、必要 worker/许可和文件哈希后
  才发布开发 dist。许可检查使用完整的必需文件清单，不以目录存在代替法律闭包。
- 分析所有 emitted JS/MJS/CJS（含 fork worker），仅允许读取同一已遍历的
  常规文件集及声明的 externals。编译后文件 import 使用普通显式路径；
  URL 编码、query/fragment、反斜杠和控制字符 specifier 均保守拒绝，避免
  文件系统路径与原生 ESM URL 指向不同实现。
- release 只安装锁定运行依赖，检查自身及所有祖先的物理宿主、拒绝路径中的
  符号链接；manifest、运行锁和 dist 完整性记录共同绑定 release digest。
  npm 的 `.bin` 链接仅可指向该运行依赖树内的常规文件。digest 用于漂移检测，
  不构成来源真实性签名。
- 发布及候选验证都在有期限的隔离子进程中，从 worker 的实际依赖树解析
  LiteParse，关闭 OCR 解析一个合成 PDF，验证 addon 和 PDFium 真实可用。
- 正式更新创建新目录，不能覆写旧 release。在途 worker 不会读到半更新产物。

## 跨模块交互

UI 读取公共工具元数据和已有结果。questions、background-shell 及第三方
Agent/StopAgent 的专用 renderer 保持优先，不因属于私有包而被接管。
footer 消费宿主提供的 extension statuses，不清理其他模块的状态键。

后台通知、`.pi/tasks` 元数据和补丁报告由对应能力维护，UI 不改写格式。
deferred questions/background/document 工具仍通过内置 `tool_search` 发现；
`defaultTools: ["+tool_search"]` 是用户选择，不由安装脚本隐式重写。
tools 模块以同名扩展覆盖内置 `grep`/`find`/`ls`，exposure 为 `codemode`：
默认不直接声明给模型，启用内置 `codemode` 后由脚本调用，显式激活仍然有效。

## 文档职责

根 README 负责定位、入口索引和安全边界；本文负责跨模块职责与依赖/产物结构；
`development.md` 负责构建、测试、隔离和发布流程；模块 README 与
`LICENSE`/`UPSTREAM.md` 负责单能力用法及继承代码的来源与许可。
