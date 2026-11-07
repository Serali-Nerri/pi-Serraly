import type { PublicRealtimeAccess } from "./realtime-auth.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractAccountId } from "../providers/openai-codex/headers.ts";

export interface CodexVoiceAuth {
	headers: Headers;
	baseUrl: string;
	officialCodex: boolean;
 realtime?: PublicRealtimeAccess;
	loginFailure?(): Error;
	env?: Record<string, string>;
}

export async function resolveCodexVoiceAuth(ctx: ExtensionContext): Promise<CodexVoiceAuth> {
	let resolved;
	try {
		resolved = await ctx.modelRegistry.getProviderAuth("openai-codex");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "oauth")
			throw voiceLoginFailure(ctx);
		throw error;
	}
	const token = resolved?.auth.apiKey;
	if (!resolved || !token) throw voiceLoginFailure(ctx);
	const nonOAuth = Boolean(
		resolved.source && resolved.source.toLowerCase() !== "oauth",
	);
	const headers = new Headers();
	for (const [name, value] of Object.entries(resolved.auth.headers ?? {})) if (value !== null) headers.set(name, value);
	headers.set("authorization", `Bearer ${token}`);
	try {
		headers.set("chatgpt-account-id", extractAccountId(token));
	} catch {
		throw voiceLoginFailure(ctx, nonOAuth);
	}
	headers.set("originator", "pi");
	headers.set("x-session-id", ctx.sessionManager.getSessionId());
	headers.set("user-agent", "pi-codex-conversion");
	const baseUrl = resolved.auth.baseUrl ?? "https://chatgpt.com/backend-api/codex";
	return {
		headers,
		baseUrl,
		officialCodex: isOfficialCodexBaseUrl(baseUrl),
		loginFailure: () => voiceLoginFailure(ctx, nonOAuth),
		...(resolved.env ? { env: resolved.env } : {}),
	};
}

function voiceLoginFailure(ctx: ExtensionContext, nonOAuth = false): Error {
	const legacy = ctx.modelRegistry.getProviderAuthStatus("openai-codex");
	if (legacy.configured) {
		if (nonOAuth)
			return new Error(
				"Codex Live could not use the configured openai-codex API key with the official Codex endpoint. Configure Codex Live provider and base URL in /codex voice for a gateway, or use /login openai-codex for direct access.",
			);
		return new Error("Voice could not use the OpenAI Codex login. Renew it with /login openai-codex (legacy OpenAI Codex).");
	}
	const openai = ctx.modelRegistry.getAll().find((model) => model.provider === "openai");
	const signin = openai && ctx.modelRegistry.isUsingOAuth(openai);
	return new Error(signin
		? "Voice requires the legacy OpenAI Codex login, not Sign in with ChatGPT. Run /login openai-codex."
		: "Voice requires an OpenAI Codex login. Run /login openai-codex (legacy OpenAI Codex).");
}

function isOfficialCodexBaseUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.hostname === "chatgpt.com" && /^\/backend-api\/codex\/?$/.test(url.pathname);
	} catch {
		return false;
	}
}
