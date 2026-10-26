import type { RecapConfig } from "./config.ts";
import type { buildHistory } from "./history.ts";
import type { Recap } from "./prompt.ts";

export interface RecapEnvironment {
	now(): number;
	schedule(callback: () => void, delayMs: number): () => void;
	isIdle(): boolean;
	history(): ReturnType<typeof buildHistory>;
	generate(history: string, signal: AbortSignal): Promise<Recap>;
	loading(active: boolean): void;
	show(recap: Recap): void;
	clear(): void;
	notify(message: string, level: "info" | "error"): void;
}

export class RecapController {
	private readonly config: Readonly<RecapConfig>;
	private readonly env: RecapEnvironment;
	// session_tree runs while Pi still reports navigation busy, not an agent run.
	// Track runs through lifecycle events and check host idleness at timer expiry.
	private idle = true;
	private idleSince: number;
	private completed: number;
	private lastSuccess = 0;
	private timer: (() => void) | undefined;
	private retry: (() => void) | undefined;
	private request: { origin: "manual" | "auto"; abort: AbortController } | undefined;
	private disposed = false;

	constructor(config: Readonly<RecapConfig>, env: RecapEnvironment) {
		this.config = config;
		this.env = env;
		this.idleSince = env.now();
		this.completed = env.history().completed;
		this.scheduleAuto();
	}

	async manual(): Promise<void> {
		if (this.disposed) return;
		if (this.request) {
			this.env.notify("A recap is already being generated.", "info");
			return;
		}
		this.cancel(); // A manual command takes over a scheduled automatic retry.
		await this.run("manual");
	}

	activity(): void {
		this.idleSince = this.env.now();
		if (this.request?.origin !== "manual") this.cancel();
		this.scheduleAuto();
	}

	submitted(): void {
		this.env.clear();
		this.cancel();
		this.activity();
	}

	started(): void {
		this.idle = false;
		this.env.clear();
		this.cancel();
	}

	settled(): void {
		this.idle = true;
		this.idleSince = this.env.now();
		this.completed = this.env.history().completed;
		this.scheduleAuto();
	}

	dispose(): void {
		this.disposed = true;
		this.cancel();
		this.env.clear();
	}

	private cancel(): void {
		this.timer?.();
		this.timer = undefined;
		this.retry?.();
		this.retry = undefined;
		this.request?.abort.abort();
		this.request = undefined;
		this.env.loading(false);
	}

	private scheduleAuto(): void {
		this.timer?.();
		this.timer = undefined;
		if (this.disposed || !this.config.auto || !this.idle || this.request || this.retry)
			return;
		if (this.completed < this.config.minTurns || this.completed - this.lastSuccess < this.config.minTurnsBetweenRecaps)
			return;
		const delay = Math.max(0, this.config.idleMinutes * 60_000 - (this.env.now() - this.idleSince));
		this.timer = this.env.schedule(() => {
			this.timer = undefined;
			if (this.env.now() - this.idleSince < this.config.idleMinutes * 60_000) this.scheduleAuto();
			else if (this.idle && this.env.isIdle()) void this.run("auto");
		}, Math.min(delay, 2_147_483_647));
	}

	private async run(origin: "manual" | "auto", retried = false): Promise<void> {
		const history = this.env.history();
		this.completed = history.completed;
		if (!history.text) {
			if (origin === "manual") this.env.notify(history.empty
				? "There is no conversation history to recap."
				: "There is no completed conversation history to recap.", "info");
			this.env.loading(false);
			return;
		}
		const abort = new AbortController();
		this.request = { origin, abort };
		this.env.loading(true);
		try {
			const recap = await this.env.generate(history.text, abort.signal);
			if (abort.signal.aborted) return;
			this.request = undefined;
			this.completed = this.env.history().completed;
			this.lastSuccess = this.completed;
			this.idleSince = this.env.now();
			this.env.loading(false);
			this.env.show(recap);
			this.scheduleAuto();
		} catch {
			if (abort.signal.aborted) return;
			this.request = undefined;
			if (origin === "auto" && !retried) {
				this.retry = this.env.schedule(() => {
					this.retry = undefined;
					void this.run("auto", true);
				}, 30_000);
			} else {
				this.env.loading(false);
				if (origin === "manual") {
					this.env.notify("Could not generate a recap. Please try again.", "error");
					this.scheduleAuto();
				} else this.idleSince = this.env.now();
			}
		}
	}
}
