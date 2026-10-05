import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DEFAULT_INTERVAL = 10 * MINUTE;
const MAX_INTERVAL = DAY;
const MAX_LOOPS = 50;
const EXPIRES_AFTER = 7 * DAY;
const STATUS_KEY = "local-loop";

export interface LoopInput {
	prompt: string;
	intervalMs: number;
	defaultInterval: boolean;
	roundedSeconds: boolean;
}

function duration(value: string, unit: string): { intervalMs: number; roundedSeconds: boolean } | string {
	const count = Number(value);
	if (!Number.isSafeInteger(count) || count <= 0) return "间隔必须为正整数。";
	const name = unit.toLowerCase();
	const seconds = name.startsWith("s");
	const factor = seconds ? 1000 : name.startsWith("m") ? MINUTE : name.startsWith("h") ? HOUR : DAY;
	const raw = count * factor;
	if (!Number.isSafeInteger(raw)) return "间隔过大。";
	const intervalMs = seconds ? Math.ceil(raw / MINUTE) * MINUTE : raw;
	if (intervalMs < MINUTE || intervalMs > MAX_INTERVAL) return "间隔须在 1 分钟至 24 小时之间。";
	return { intervalMs, roundedSeconds: seconds && raw !== intervalMs };
}

/** Parses /loop arguments into an interval and prompt. */
export function parseLoopInput(args: string): LoopInput | string {
	const input = args.trim();
	if (!input) return "用法：/loop [5m|2h|1d] <提示词>；/loop list|stop <ID> 管理任务。";
	let prompt = input;
	let parsed: ReturnType<typeof duration> | undefined;
	const leading = /^(\d+)(s|m|h|d)(?:\s+|$)/iu.exec(input);
	if (leading) {
		prompt = input.slice(leading[0].length).trim();
		parsed = duration(leading[1]!, leading[2]!);
	} else {
		const trailing = /^(.*?)\s+every\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smhd])\s*$/iu.exec(input);
		if (trailing) {
			prompt = trailing[1]!.trim();
			parsed = duration(trailing[2]!, trailing[3]!);
		}
	}
	if (!prompt) return "请提供要重复执行的提示词，例如：/loop 5m 检查构建结果。";
	if (typeof parsed === "string") return parsed;
	return {
		prompt,
		intervalMs: parsed?.intervalMs ?? DEFAULT_INTERVAL,
		defaultInterval: !parsed,
		roundedSeconds: parsed?.roundedSeconds ?? false,
	};
}

interface LoopJob extends LoopInput {
	id: string;
	nextAt: number;
	expiresAt: number;
	pending: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

export default function (pi: ExtensionAPI): void {
	const jobs = new Map<string, LoopJob>();
	let sessionId: string | undefined;
	let dispatching = false;
	let watchdog: ReturnType<typeof setTimeout> | undefined;

	function resetDispatch(): void {
		if (watchdog !== undefined) clearTimeout(watchdog);
		watchdog = undefined;
		dispatching = false;
	}

	function status(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, jobs.size ? `loops: ${jobs.size}` : undefined);
	}

	function stop(id: string, ctx: ExtensionContext): boolean {
		const job = jobs.get(id);
		if (!job) return false;
		if (job.timer) clearTimeout(job.timer);
		jobs.delete(id);
		status(ctx);
		return true;
	}

	function clear(ctx: ExtensionContext): void {
		for (const job of jobs.values()) if (job.timer) clearTimeout(job.timer);
		jobs.clear();
		resetDispatch();
		status(ctx);
	}

	function validSession(ctx: ExtensionContext): boolean {
		return sessionId !== undefined && sessionId === ctx.sessionManager.getSessionId();
	}

	function flush(ctx: ExtensionContext): void {
		if (dispatching || !validSession(ctx) || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		const job = [...jobs.values()].find((entry) => entry.pending);
		if (!job) return;
		if (Date.now() >= job.expiresAt) {
			stop(job.id, ctx);
			flush(ctx);
			return;
		}
		job.pending = false;
		dispatching = true;
		// Only known Pi skills/templates may start with '/'. Built-in TUI commands are not dispatched here.
		try {
			pi.sendUserMessage(job.prompt, { expandPromptTemplates: job.prompt.startsWith("/") });
		} catch (error) {
			resetDispatch();
			throw error;
		}
		// If dispatch fails before agent_start, do not leave this session permanently locked.
		watchdog = setTimeout(() => {
			watchdog = undefined;
			if (validSession(ctx) && ctx.isIdle()) dispatching = false;
		}, 5000);
		watchdog.unref?.();
	}

	function schedule(job: LoopJob, ctx: ExtensionContext): void {
		const dueAt = Math.min(job.nextAt, job.expiresAt);
		job.timer = setTimeout(() => {
			if (!jobs.has(job.id) || !validSession(ctx)) return;
			const now = Date.now();
			if (now >= job.expiresAt) {
				stop(job.id, ctx);
				ctx.ui.notify(`Loop ${job.id} 已到期（7 天）。`, "info");
				return;
			}
			job.pending = true;
			// Skip missed intervals rather than issuing a backlog of model turns.
			job.nextAt = Math.max(job.nextAt + job.intervalMs, now + job.intervalMs);
			schedule(job, ctx);
			flush(ctx);
		}, Math.max(0, dueAt - Date.now()));
		job.timer.unref?.();
	}

	function list(ctx: ExtensionContext): void {
		if (jobs.size === 0) {
			ctx.ui.notify("当前会话没有运行中的 Loop。", "info");
			return;
		}
		const lines = [...jobs.values()].map((job) => {
			const preview = job.prompt.replace(/\s+/gu, " ").slice(0, 75);
			return `${job.id}  ${job.intervalMs / MINUTE}m  ${job.pending ? "等待空闲" : `下次 ${new Date(job.nextAt).toLocaleString()}`}  ${preview}`;
		});
		ctx.ui.notify(`当前 Loop：\n${lines.join("\n")}\n用 /loop stop <ID> 停止。`, "info");
	}

	pi.on("session_start", (_event, ctx) => {
		clear(ctx);
		sessionId = ctx.sessionManager.getSessionId();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		clear(ctx);
		sessionId = undefined;
	});
	pi.on("agent_start", () => { resetDispatch(); });
	pi.on("agent_settled", (_event, ctx) => {
		resetDispatch();
		flush(ctx);
	});

	pi.registerCommand("loop", {
		description: "每隔一段时间重复提示词：/loop 5m <提示词>；/loop list|stop <ID>",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (input === "list") return list(ctx);
			if (input.startsWith("stop ")) {
				const id = input.slice(5).trim();
				ctx.ui.notify(stop(id, ctx) ? `已停止 Loop ${id}。` : `找不到 Loop ${id}。`, "info");
				return;
			}
			const parsed = parseLoopInput(input);
			if (typeof parsed === "string") return ctx.ui.notify(parsed, "warning");
			if (!validSession(ctx)) return ctx.ui.notify("会话尚未就绪。", "warning");
			if (jobs.size >= MAX_LOOPS) return ctx.ui.notify(`当前会话最多 ${MAX_LOOPS} 个 Loop。`, "warning");
			if (parsed.prompt.startsWith("/")) {
				const name = /^\/([^\s]+)/u.exec(parsed.prompt)?.[1];
				const command = pi.getCommands().find((item) => item.name === name);
				if (command?.source !== "skill" && command?.source !== "prompt") {
					return ctx.ui.notify("只能重复运行已加载的 /skill:名称 或提示词模板；Pi 内置命令不支持定时执行。", "warning");
				}
			}
			let id: string;
			do { id = randomBytes(4).toString("hex"); } while (jobs.has(id));
			const now = Date.now();
			const job: LoopJob = {
				...parsed, id, nextAt: now + parsed.intervalMs,
				expiresAt: now + EXPIRES_AFTER, pending: true,
			};
			jobs.set(id, job);
			schedule(job, ctx);
			status(ctx);
			const note = parsed.defaultInterval ? "（未指定间隔，采用固定 10 分钟）" : "";
			const rounding = parsed.roundedSeconds ? "（秒数已向上取整至整分钟）" : "";
			ctx.ui.notify(`Loop ${id}：每 ${job.intervalMs / MINUTE} 分钟；立即执行一次，7 天后到期。${note}${rounding}`, "info");
			flush(ctx);
		},
	});
}
