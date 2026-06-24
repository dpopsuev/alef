import { traceEvent } from "@dpopsuev/alef-kernel/log";

const REREAD_THRESHOLD = 3;

export class DegradationDetector {
	private readonly fileReads = new Map<string, number>();
	private readonly toolRepetitions = new Map<string, number>();
	private turnCount = 0;

	onToolEnd(name: string, args: Record<string, unknown>): string | undefined {
		const key = `${name}:${JSON.stringify(args)}`;
		const count = (this.toolRepetitions.get(key) ?? 0) + 1;
		this.toolRepetitions.set(key, count);

		if (name === "fs.read" || name === "fs_read") {
			const path = typeof args.path === "string" ? args.path : "";
			if (path) {
				const reads = (this.fileReads.get(path) ?? 0) + 1;
				this.fileReads.set(path, reads);
				if (reads >= REREAD_THRESHOLD) {
					traceEvent("degradation:reread", { path, reads });
					return `You have read '${path}' ${reads} times this session. The content is already in your conversation history — check earlier turns instead of re-reading.`;
				}
			}
		}

		if (count >= REREAD_THRESHOLD) {
			traceEvent("degradation:repeated-call", { name, count });
			return `You have called ${name} with the same arguments ${count} times. This may indicate context loss — review your earlier results.`;
		}

		return undefined;
	}

	onTurnStart(): void {
		this.turnCount++;
	}

	stats(): { fileReads: number; repeatedCalls: number; turns: number } {
		const repeated = [...this.toolRepetitions.values()].filter((c) => c >= REREAD_THRESHOLD).length;
		return {
			fileReads: this.fileReads.size,
			repeatedCalls: repeated,
			turns: this.turnCount,
		};
	}
}
