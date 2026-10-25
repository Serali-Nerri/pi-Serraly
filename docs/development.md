# 开发、验证与本地交付

## 工具链与命令

Node ≥22.19、Bun 1.4.2、Pi 1.4.0。依赖只在安装阶段访问 registry：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run check
bun run test:packages
npm test
npm run verify
bun run build -- --package pi-codex-conversion
bun run check -- --package pi-codex-conversion
bun run test -- --package pi-codex-conversion
bun run release -- --output /absolute/path/to/new-release
```

build 构建 conversion、browser、agent-board、pi-ui，其余包保留 TS 入口；`--package` 只构建选定包及其 workspace 构建依赖。check 执行各包静态检查和根脚本语法检查。test:packages 只运行包测试；test 运行包和集成测试，`--package` 运行选定包测试及对应集成测试（conversion 的工具卡/工具接入、pi-ui 的宿主展示）。verify 按 build → check → test 执行一次。检查和测试不修复产物。

单包修改先运行对应 build/check/test；跨包依赖、安装或 release 工具改变时运行完整 verify。包版本跟随各自上游基线，本地差异使用 Git 提交和包内本地 changelog 记录，不要求同步抬升所有包版本；根版本仅标识可选的整仓快照。

不使用 Changesets、全仓发布工作流或 npm 发布命令。原生源码改变时显式运行 conversion 对应构建脚本，普通 TS 构建不重新编译跨平台原生程序。

## 测试与隔离

默认删除永久测试，仅保留静态检查和一次性探针无法充分覆盖、且失败后果重要的覆盖；新增额外覆盖须由用户明确要求。不强制 TDD，不以测试数量或契约标签作为保留理由。通过公开入口或既有 seam 验证行为，不重复依赖算法，不断言源码文本或私有调用顺序。易错的编辑与顺序约束写在最近的 AGENTS.md，运行时校验留在拥有该数据的实现中。

自动命令使用临时 HOME、XDG 和 PI_CODING_AGENT_DIR；宿主会话及工具执行夹具另用临时工作目录，构建和静态检查在源码包目录运行。环境 allowlist 不携带 provider keys、代理或真实会话路径；Node 网络拒绝覆盖子进程，允许明确本地回环夹具。结束清理自己的文件、计时器、进程和 worker。依赖安装的 registry 访问需要明确授权，其余检查和探针默认离线。

程序化探针可用已发布 Pi 的公开 API 加载实际候选包，检查资源、依赖、注册和合成 session/shutdown，不读取真实凭据或请求真实模型。真实登录、真实模型与外部服务验收必须先获得明确授权，可在方案阶段约定。真实 sandbox 验收是在 Herdr 中连续交互 Pi TUI 并执行工具、使用 guest；程序化探针不能替代它。源码改变后先刷新 guest 候选，再验收；报告未执行或受阻的部分。

需要完整验证时收尾运行一次 npm run verify；迭代只跑相关检查。视觉变化查看隔离 PTY，回收通过可达性验证，不断言固定堆字节数。

pi-ui 的行为测试通过真实 Pi 消息/终端组件、扩展事件和隔离配置文件覆盖展示、历史、交互及清理。编译入口必须经 bundled Pi loader 验证真实宿主组件得到装饰，不能仅在直接导入源码时验收；流式回收测试确认旧帧和启动 context 可回收。动画检查不得依靠每帧读取 session 历史。界面验收包含明暗主题、窄屏、拖选和宿主快捷键，不请求真实模型。

## 本地安装 checkout

使用独立于开发目录的完整仓库 checkout，例如 `~/.pi/pi-Serraly`；不必先创建 release，也不将开发目录登记到真实 Pi。同步时保留目录中与仓库无关的现有数据。

在安装 checkout 中按普通 workspace 流程准备依赖和构建：

```sh
cd ~/.pi/pi-Serraly
bun install --frozen-lockfile --ignore-scripts
bun run build
# 构建后移除开发依赖树，再准备不含物理 Pi host 的运行依赖：
find packages -name node_modules -prune -exec rm -rf {} +
rm -rf node_modules
bun install --production --omit peer --frozen-lockfile --ignore-scripts --linker hoisted
# 获得真实设置变更授权、验证备份和恢复后，逐包登记：
pi install ~/.pi/pi-Serraly/packages/pi-codex-conversion
pi install ~/.pi/pi-Serraly/packages/pi-ask
pi list
```

缓存齐全时两次 install 都可加 `--offline`。缓存不足时先申请依赖安装所需的 registry 访问。不要复制开发 node_modules；宿主包由运行中的 Pi 提供，不能把构建用的物理 Pi 副本留在运行依赖树。需要再次构建或检查时，先恢复完整开发依赖，结束后重新准备生产依赖。

Pi 对本地包只登记并原地加载，不复制、不构建、不安装依赖；删除登记用 `pi remove <source>`。本地代码更新由 Git/Bun 完成，不依赖 `pi update` 拉取。workspace 运行依赖正常安装，例如 Shepherdr 使用 agent-board，但只有显式登记其包入口才启用 agent-board；根包的 pi 资源数组为空，不通过安装根目录启用全部扩展。

更新前记录安装 checkout 的 Git 状态并保留可恢复副本，再同步完整仓库和锁文件、重新准备依赖与产物。整个 checkout 是一个 workspace，更新可影响其中多个已登记包。路径不变时无需重写设置，下一次完整启动加载更新。回滚恢复完整 checkout；如果改过登记路径，还需恢复 settings 备份。

真实设置切换必须验证备份可原样恢复；迁移时替换原 source，保留资源启停过滤及无关配置。Pi 会将本地路径规范化为相对配置目录的 source；`pi config` 显示该原文，实际路径以 `pi list` 为准。验收完成后可清理不再使用的安装目录和备份。

## 可选整合包

`pi-extensions` 为除 pi-ui 外的七个功能包提供独立入口，包括 agent-board；browser 和 agent-board 的独立 changelog 也各有入口。默认全部启用，`pi config` 在包的 Extensions 分组中逐项列出这九个文件，可分别开关。pi-ui 继续独立安装。

```sh
# 先移除这七个成员的单包登记，备份并保留所需配置：
pi install ~/.pi/pi-Serraly/packages/pi-extensions
```

不要让整合包与成员同时登记。只想启用部分成员时，可逐包安装，也可在整合包的资源开关中禁用不需要的入口；独立 changelog 入口单独控制。整合包依赖使用 workspace 版本，整合包自己的版本独立于成员上游基线。

## 可选整仓 Release

先完成 verify，根版本采用新版本号（预览带 prerelease），发布到新路径：

```sh
bun run release
# 默认 ~/.local/share/pi-Serraly/releases/<根版本>
bun run release -- --output /absolute/path/to/new-release
# 另行授权后，逐包装入真实 Pi：
# pi install /absolute/path/to/new-release/packages/pi-codex-conversion
```

release 不构建、不联网、不改真实设置。按各包 files 清单交付源码、产物、许可和资源，从本地 Bun 缓存安装锁定生产依赖，保留已交付成员之间的 peer 导入链接，排除物理宿主 peer 与开发工具；缺缓存或产物即失败。同级临时目录完成组装再发布，拒绝覆盖、开发树内目标和向外链接。

真实切换遵循上述授权和 settings 备份要求；只改选定包路径，下一次完整启动加载新版本。回滚恢复 settings 备份指回旧 release，不覆写版本、不自动 reload 或终止会话。

## 手动同步上游

1. 选固定提交，阅读根和七包 UPSTREAM，逐包对比，不能直接覆盖目录。
2. 核对 peer/运行依赖、Pi/Node 基线、原生程序、WASM、profiles、远端脚本、许可和新增跨包引用。
3. 手动合入所需变更，保留局部点击展开、生命周期约束和本仓 CDP 维护源；渲染主体及 Display 默认值跟随上游，不恢复未迁入包工作流。
4. 更新来源和当前差异，文档只说明当前契约，不累积工作日志。
5. 显式更新 Bun 锁文件，运行相关检查、完整 verify，同步安装 checkout 或创建整仓快照。

上游个人工作流不是本仓配置。各包已有配置/数据的运行行为沿用上游；工程迁移不读取或重写真实用户状态。
