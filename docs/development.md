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
bun run release -- --output /absolute/path/to/new-release
```

build 构建 conversion、browser、agent-board、pi-ui，其余包保留 TS 入口。check 执行各包静态检查和根脚本语法检查；test:packages 运行包测试；test 运行包和集成测试；verify 按 build → check → test 执行一次。定向调试：`bun run check -- --package pi-ui` 或 `bun run test -- --package pi-codex-conversion`。检查和测试不修复产物。

不使用 Changesets、全仓发布工作流或 npm 发布命令。原生源码改变时显式运行 conversion 对应构建脚本，普通 TS 构建不重新编译跨平台原生程序。

## 测试与隔离

测试保护本仓接入、资源/依赖闭包、固定版本发布、生命周期与渲染契约，不重复 Pi/Node 算法，不以源码文本快照替代行为。先观察新增测试失败，再做最小实现；保留有意义的上游行为测试，通过公开入口或既有 seam 验证。组合测试只保留影响受测路径的维度；相同的错误展示和内容完整性保证使用代表场景验证。

命令使用临时 HOME、XDG 和 PI_CODING_AGENT_DIR；宿主会话及工具执行夹具另用临时工作目录，构建和静态检查在源码包目录运行。环境 allowlist 不携带 provider keys、代理或真实会话路径；Node 网络拒绝覆盖子进程，允许明确本地回环夹具。结束清理自己的文件、计时器、进程和 worker。不能访问真实 auth/settings/session 或请求真实模型。

实际 Pi loader 加载 release 包并触发合成 session/shutdown；渲染使用真实宿主组件及合成结果。浏览器/CDP、Herdr、图像服务等外部登录/网络场景不被离线验证替代，须报告未验收部分。

收尾只运行一次 npm run verify；迭代只跑相关检查。视觉变化查看隔离 PTY，回收通过可达性验证，不断言固定堆字节数。

pi-ui 的行为测试通过真实 Pi 消息/终端组件、扩展事件和隔离配置文件覆盖展示、历史、交互及清理。编译入口必须经 bundled Pi loader 验证真实宿主组件得到装饰，不能仅在直接导入源码时验收；流式回收测试确认旧帧和启动 context 可回收。动画检查不得依靠每帧读取 session 历史。界面验收包含明暗主题、窄屏、拖选和宿主快捷键，不请求真实模型。

## Release

先完成 verify，根版本采用新版本号（预览带 prerelease），发布到新路径：

```sh
bun run release
# 默认 ~/.local/share/pi-Serraly/releases/<根版本>
bun run release -- --output /absolute/path/to/new-release
# 另行授权后，逐包装入真实 Pi：
# pi install /absolute/path/to/new-release/packages/pi-codex-conversion
```

release 不构建、不联网、不改真实设置。按各包 files 清单交付源码、产物、许可和资源，从本地 Bun 缓存安装锁定生产依赖，保留已交付成员之间的 peer 导入链接，排除物理宿主 peer 与开发工具；缺缓存或产物即失败。同级临时目录完成组装再发布，拒绝覆盖、开发树内目标和向外链接。

真实切换须另行授权，备份并验证 settings 可原样恢复；只改选定包路径，下一次完整启动加载新版本。回滚恢复备份指回旧 release，不覆写版本、不自动 reload 或终止会话。

`pi config` 按配置中的包 source 原文显示来源；不希望标题以 `../` 开头时，可在 `packages` 字符串或对象的 `source` 中使用 `~/.pi/pi-Serraly/releases/<根版本>/packages/<包目录>`。该写法适用于显式发布到 `~/.pi/pi-Serraly/releases/<根版本>` 的交付，`~` 解析为用户 HOME；路径必须指向已完成的新 release，启停过滤保持不变。若不保留配置备份，先用临时副本验证原样恢复，切换校验成功后再删除临时副本；仓库本身不包含个人 settings，不能代替该校验。

## 手动同步上游

1. 选固定提交，阅读根和七包 UPSTREAM，逐包对比，不能直接覆盖目录。
2. 核对 peer/运行依赖、Pi/Node 基线、原生程序、WASM、profiles、远端脚本、许可和新增跨包引用。
3. 手动合入所需变更，保留局部点击展开、生命周期约束和本仓 CDP 维护源；渲染主体及 Display 默认值跟随上游，不恢复未迁入包工作流。
4. 更新来源和当前差异，文档只说明当前契约，不累积工作日志。
5. 显式更新 Bun 锁文件，运行相关测试、完整 verify，发布新固定版本。

上游个人工作流不是本仓配置。各包已有配置/数据的运行行为沿用上游；工程迁移不读取或重写真实用户状态。
