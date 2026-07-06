/**
 *
 */
export class AsyncQueue {
	private readonly queue: string[] = [];
	private resolve: (() => void) | undefined;
	private done = false;

	push(text: string): void {
		this.queue.push(text);
		this.resolve?.();
		this.resolve = undefined;
	}

	finish(): void {
		this.done = true;
		this.resolve?.();
		this.resolve = undefined;
	}

	async *iter(): AsyncIterable<string> {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite loop, exits via return when done
		while (true) {
			while (this.queue.length > 0) {
				const item = this.queue.shift();
				if (item !== undefined) yield item;
			}
			if (this.done) return;
			await new Promise<void>((r) => {
				this.resolve = r;
			});
		}
	}
}
