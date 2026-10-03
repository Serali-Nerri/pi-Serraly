import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerContext from "./config/context-command.ts";
import registerMarkdown from "./markdown/index.ts";
import { registerUiLifecycle } from "./lifecycle.ts";

export default function piUi(pi: ExtensionAPI): void {
	registerMarkdown(pi);
	registerContext(pi);
	registerUiLifecycle(pi);
}
