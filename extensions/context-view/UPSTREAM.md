# 来源与许可

- 上游：[dimk90/pi-context-view](https://github.com/dimk90/pi-context-view)，作者 Dmitry Makarov。
- 内化基线：版本字段 0.6.0，固定提交 `0eb5f9773c91b63b873da4d9ca6fa6caf795e91a`。
  此提交不是 v0.6.0 标签提交，不以标签代替固定来源。
- MIT 全文及版权保留在 [LICENSE](LICENSE)，随 dist 与 packed/release payload 传播。

保留 Usage 组成估算、冻结 Initial、prompt/transcript 分类、地图、导航、内容/JSON/skill
预览、颜色与地图偏好，以及相关上游行为套件。改为 context-view 独立 workspace /
bundle 入口及自有显示偏好文件；使用仓库固定 Pi 1.0.4 / TypeScript 版本。
有界读取 bundle pi-config-core，模块继续拥有验证、默认和 create-only 政策。
wheel 不读取宿主私有字段；使用公开归一化鼠标事件及固定 raw fallback。

不保留静默探测、空用户消息、探测 abort/消息清洗/身份持久化、旧键迁移及相关失效测试。
未捕获时显示 session estimate / not captured，不伪造观测。
不采用上游发布脚本、包管理 lock、开发 pins、演示 dump 工具或安装指导。
捕获与预览保持进程内；不新增落盘请求副本、共享 viewer 框架或宿主补丁。
测试 fixture 的 exposure/host 导入适配不放宽类型检查。
