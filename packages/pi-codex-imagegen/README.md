# pi-codex-imagegen

Image generation and editing through Codex OAuth or the OpenAI API, for ordinary Pi, Code Mode, and Notebook Mode.

## Install

Prepare the installation workspace as described in [development](../../docs/development.md#本地安装工作区), then register its package path:

    pi install ~/.pi/pi-Serraly/packages/pi-codex-imagegen

Requires Pi 1.5 or newer and Node.js 22.19 or newer.

Run `/login openai-codex` for the normal Codex route, including when chatting with another provider. Compatible active Codex transports keep their own credentials. Pi Codex's resolver is preferred when present, but its conversation-provider scope does not select tool endpoints. Neither Pi Codex nor an install script is required.

Pi Codex Conversion 5.0.0 or newer is optional. With it installed, the normal imagegen tool becomes tools.image_gen__imagegen inside Code and Notebook Mode.

## Access and preferences

Open `/imagegen` in Pi's TUI to choose access. Codex OAuth is the default and preserves compatible configured Codex routes. OpenAI API defaults to `https://api.openai.com/v1` and the `openai` credentials already configured in Pi. Official API billing is separate from your Codex subscription. Neither route falls back to the other.

For API access, set the API base URL, credential provider ID and model. The base URL includes any prefix such as `/v1`; Imagegen appends `/images/generations` or `/images/edits`. The selected Pi provider supplies only its API key, sent as a Bearer token: its base URL and custom headers are not inherited. Blank URL/provider entries restore the official defaults. The chat model does not select this route.

Choose a Flare/Sunburst preset or enter a custom image model ID. All API models offer the upstream quality choices Auto/Low/Medium/High/XHigh/Max; changing models preserves the selected quality. The 2.6 presets also expose planning complexity (High by default), GIF and SVG. Other models use PNG/JPEG/WebP and omit complexity. Availability in settings does not guarantee that a model or third-party endpoint supports every quality, format or size.

Preferences are saved as `imagegen.json` in Pi's agent directory without credentials; existing upstream preference files remain valid. Codex access does not expose a Flare or Sunburst choice because its endpoint does not confirm which image model runs.

### OpenAI-compatible gateways

For a gateway such as CLIProxyAPI, select OpenAI API access, enter its Images API base URL, the ID of an already configured Pi provider holding the gateway key, and a model the gateway supports. For example:

```json
{
	"access": "openai",
	"api": {
		"baseUrl": "http://localhost:8317/v1",
		"provider": "my-image-gateway",
		"model": "gpt-image-2.5",
		"quality": "auto",
		"complexity": "high"
	}
}
```

Here `my-image-gateway` is an example provider ID, not a built-in provider. `complexity` is retained for switching back to a preset but is not sent for this custom model. The gateway owns account pooling, billing and image availability; no pooled-account credentials belong in this file. Use its `/v1` Images API route, not a Codex `/backend-api` chat route. Generation and edits use JSON; edits send `images: [{ image_url: "data:…" }]`. The endpoint must return base64 image data in `data[].b64_json`.

## Use

Provide only a prompt to generate. For edits, provide up to five local image paths, or select the smallest recent conversation-image count that covers the targets. Codex accepts PNG, JPEG, GIF and WebP inputs. OpenAI API accepts PNG, JPEG and WebP inputs.

The agent chooses the available output format, size, transparency and animation timing for each request. API access exposes PNG, JPEG and WebP generation and editing; Flare/Sunburst presets also expose native GIF and SVG generation. GIF and SVG edits are unsupported. Transparent output requires PNG or WebP. Codex keeps its existing PNG generation and editing behaviour; describe size and aspect ratio in the prompt there.

Images are saved beneath the workspace at `.pi/openai-codex-images` with a format-specific alias such as `latest.png` or `latest.gif`. GIF files retain their animation and provide a still preview when available. SVG is saved as a file without an inline preview.

Pi displays result images; Imagegen's tool card renders only text and paths, without a second preview. Model-visible image content is unchanged.

For a proxy that renames Codex providers or models, create `pi-codex-tools.json` in Pi's agent directory:

```json
{
	"providers": {
		"company-codex": {
			"gpt-image-2.5": "company-image"
		}
	}
}
```

Each provider key identifies a Codex endpoint route. Its object maps the tool's canonical model names to that provider's aliases. Use an empty object when the provider renames no models.
