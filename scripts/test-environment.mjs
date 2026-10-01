import { isolatedEnvironment } from "./preview.mjs";

/** Only deliberate non-secret controls are forwarded to isolated test children. */
export function testEnvironment(base, controls = {}) {
	const env = isolatedEnvironment(base);
	// Unit fixtures exercise native OSC8 pointer regions explicitly. CLI preview
	// sandboxes separately keep their own hyperlink setting.
	env.PI_HYPERLINKS = "1";
	if (typeof controls.PI_UI_HOST_PACKAGE === "string" && controls.PI_UI_HOST_PACKAGE) {
		env.PI_UI_HOST_PACKAGE = controls.PI_UI_HOST_PACKAGE;
	}
	return env;
}
