export function makeWriteQueue() {
	const queues = new Map<string, Promise<void>>();

	return async function withQueue<T>(absolutePath: string, fn: () => Promise<T>): Promise<T> {
		const prev = queues.get(absolutePath) ?? Promise.resolve();
		let resolve!: () => void;
		const gate = new Promise<void>((res) => {
			resolve = res;
		});
		queues.set(absolutePath, gate);
		try {
			await prev;
			return await fn();
		} finally {
			resolve();
			if (queues.get(absolutePath) === gate) queues.delete(absolutePath);
		}
	};
}
