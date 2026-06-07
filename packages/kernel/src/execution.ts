export interface SendRequest {
	text: string;
	sender?: string;
	timeoutMs?: number;
	onChunk?: (chunk: string) => void;
}

export interface ExecutionStrategy {
	send(req: SendRequest): Promise<string>;
	dispose?(): void;
}
