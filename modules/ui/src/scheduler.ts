/** One timer owns all UI animation and deferred refresh work. */
let currentScheduler: UiScheduler | undefined;

export function bindUiScheduler(scheduler: UiScheduler): () => void {
	currentScheduler = scheduler;
	return () => { if (currentScheduler === scheduler) currentScheduler = undefined; };
}

export function getUiScheduler(): UiScheduler | undefined { return currentScheduler; }

export class UiScheduler {
	private jobs = new Map<string, { at: number; interval?: number; callback: () => void }>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private render: ((force?: boolean) => void) | undefined;
	private onError: ((error: unknown) => void) | undefined;
	private active = false;

	start(requestRender: (force?: boolean) => void, onError?: (error: unknown) => void): void {
		this.dispose();
		this.active = true;
		this.render = requestRender;
		this.onError = onError;
	}

	request(force = false): void {
		if (this.active) this.render?.(force);
	}

	schedule(key: string, delayMs: number, callback: () => void, repeat = false): () => void {
		if (!this.active) return () => {};
		const job = { at: Date.now() + Math.max(0, delayMs), interval: repeat ? Math.max(1, delayMs) : undefined, callback };
		this.jobs.set(key, job);
		this.arm();
		return () => {
			if (this.jobs.get(key) !== job) return;
			this.cancel(key);
		};
	}

	cancel(key: string): void {
		this.jobs.delete(key);
		this.arm();
	}

	private arm(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.active || this.jobs.size === 0) return;
		const at = Math.min(...Array.from(this.jobs.values(), (job) => job.at));
		this.timer = setTimeout(() => this.tick(), Math.max(0, at - Date.now()));
		this.timer.unref?.();
	}

	private tick(): void {
		this.timer = undefined;
		const now = Date.now();
		for (const [key, job] of Array.from(this.jobs)) {
			if (!this.active) break;
			if (this.jobs.get(key) !== job || job.at > now) continue;
			if (job.interval === undefined) this.jobs.delete(key);
			else job.at = now + job.interval;
			try { job.callback(); } catch (error) {
				try { this.onError?.(error); } catch { /* Reporting cannot stop other jobs. */ }
			}
		}
		this.arm();
	}

	get pendingJobs(): number { return this.jobs.size; }

	dispose(): void {
		this.active = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.jobs.clear();
		this.render = undefined;
		this.onError = undefined;
	}
}
