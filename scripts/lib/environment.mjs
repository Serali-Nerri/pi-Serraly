import { dirname, join } from "node:path";
import { hostPackage } from "./host.mjs";

/**
 * Isolated HOME/config/cache and an allowlist environment. Generic callers must
 * not inherit credentials, session pointers, proxy settings or original HOME,
 * and must not carry UI-preview stage/report paths.
 */
export function isolatedEnvironment(base) {
	// Allowlist, not secret-name heuristics: no credentials, NODE_OPTIONS, session
	// pointers, provider endpoints, proxy settings, or original HOME survive.
	return {
		PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
		HOME: join(base, "home"), XDG_CONFIG_HOME: join(base, "home/.config"),
		XDG_CACHE_HOME: join(base, "home/.cache"), TMPDIR: base,
		LANG: "C.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor",
		PI_CODING_AGENT_DIR: join(base, "agent"), PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
		PI_IMAGE_PROTOCOL: "none", PI_HYPERLINKS: "0", PI_TRUE_COLOR: "1",
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: base,
		NODE_COMPILE_CACHE: join(base, "compile-cache"),
	};
}

/** Resolve host code before replacing HOME; never forward managed-install or user settings. */
export function testEnvironment(base) {
	const env = isolatedEnvironment(base);
	// Unit fixtures exercise native OSC8 pointer regions explicitly. CLI preview
	// sandboxes separately keep their own hyperlink setting.
	env.PI_HYPERLINKS = "1";
	env.PI_UI_HOST_PACKAGE = hostPackage().directory;
	return env;
}
