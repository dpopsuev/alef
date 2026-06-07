export class Watchdog {
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly stallMs: number,
		private readonly onStall: () => void,
	) {}

	start(): void {
		this.arm();
	}

	reset(): void {
		if (this.timer === null) return;
		clearTimeout(this.timer);
		this.arm();
	}

	stop(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private arm(): void {
		this.timer = setTimeout(() => {
			this.timer = null;
			this.onStall();
		}, this.stallMs);
	}
}
