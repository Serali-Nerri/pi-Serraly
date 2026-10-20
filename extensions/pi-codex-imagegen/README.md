# pi-codex-imagegen

独立的 `imagegen` 扩展：保留上游图片生成、编辑、产物和展示，增加 Pi `openai`
认证。要求 Pi 1.3.0、Node ≥22.19。没有斜杠命令，也不提供新的登录流程。

## 认证与请求

新增 OpenAI 认证通过 Pi 的 model registry 解析和刷新，不自行读写 auth.json，
也不要求旧 Codex 的 JWT account ID。旧 Codex 路由沿用上游认证和诊断。

| 选择的认证 | 请求通道 |
| --- | --- |
| 当前 `openai` / `openai-responses` 的 API Key，包括自定义 base URL 网关 | `/images/generations`、`/images/edits` |
| 当前 `openai` / `openai-responses` 的新版 ChatGPT 订阅 OAuth | `/responses` 的 `image_generation` 工具；顶层使用所选聊天模型 |
| 当前 Codex transport 或明确配置的 Codex provider | 保留上游原生 Codex 路径 |
| 其他聊天 provider | 优先使用有认证的 `openai` Responses 模型；没有时保留旧 Codex fallback |

官方 `openai` 可用 `/login openai` 登录，或按 Pi 的 provider 配置提供 API Key；
网关继续使用 `models.json` 的 base URL、认证和 headers，不把网关密钥解释为
Codex JWT。所选 OpenAI 认证失败时直接报告错误，不偷偷换用另一账号或重试生成。
OAuth 图片工具和聊天模型的权限仍由服务端决定；离线测试不代表真实账号已获权限。

工具参数与上游一致：`prompt`、可选 `transparent_background`，以及至多五个
`referenced_image_paths` 或 `num_last_images_to_include`。两个编辑选择器不能同时使用。
支持 PNG、JPEG、GIF、WebP；最近图片仅取当前 compaction-aware 上下文。

模型名默认 `gpt-image-2.5`。上游 `pi-codex-tools.json` 的 provider 模型映射仍可用：

```json
{
  "providers": {
    "openai": { "gpt-image-2.5": "gpt-image-2.5-sunburst" }
  }
}
```

`openai` 的此映射只更名图片模型，不把 OpenAI 认证改成旧 Codex transport；
其他 provider 的条目仍按上游约定声明 Codex 兼容路由。

图片保存在工作区 `.pi/openai-codex-images/`，首图同时写入 `latest.png`。
普通 Pi 使用直接注册的 `imagegen`；可选 PCC ≥4.0.2 将图片投影放入
Code/Notebook Mode 的发现清单和 `ALL_TOOLS`，按需读取其完整契约后以
`generatedImage(await tools.image_gen__imagegen({...}))` 调用。PCC 桥接使用
`deferLoading: true`、`discoverWhenDeferred: true`；原生工具仍直接注册，保证
桥接的宿主调用资格。安装 PCC 不是图片工具的前提。

## 安装边界与维护

运行入口是 `dist/pi-codex-imagegen.js`。使用仓库的不可变 release；不要加载
开发 dist，也不要与 `npm:@howaboua/pi-codex-imagegen` 同时启用。
本工作区不自动修改真实 settings、切换模型、登录或生成样例图片。

固定来源、文件对应关系和更新步骤见 [UPSTREAM.md](UPSTREAM.md)。上游 MIT
许可见 [LICENSE](LICENSE)；Codex 参考许可见
[licenses/openai-codex-Apache-2.0.txt](licenses/openai-codex-Apache-2.0.txt)。
