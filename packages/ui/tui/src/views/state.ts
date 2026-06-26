export interface TuiState {
	modelId: string;
	thinkingLevel: string;
	inputTokens: number;
	outputTokens: number;
	contextWindow: number;
	contextUsed: number;
	compacted: boolean;
}

export class TuiStateStore {
	private state: TuiState;
	private readonly listeners = new Set<() => void>();

	constructor(initial: TuiState) {
		this.state = { ...initial };
	}

	get(): Readonly<TuiState> {
		return this.state;
	}

	update(partial: Partial<TuiState>): void {
		let changed = false;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Object.keys returns string[], narrowing to keyof TuiState is safe for index access
		for (const key of Object.keys(partial) as (keyof TuiState)[]) {
			if (this.state[key] !== partial[key]) {
				changed = true;
				break;
			}
		}
		if (!changed) return;
		this.state = { ...this.state, ...partial };
		for (const l of this.listeners) l();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
