export interface ChildEntry {
	name: string;
	endpoint: string;
	sessionId: string | undefined;
	pid: number;
	process: import("node:child_process").ChildProcess;
	startedAt: number;
}

export interface SpawnResult {
	name: string;
	endpoint: string;
	sessionId: string;
	pid: number;
}

export interface EvalResult {
	passed: boolean;
	score: number;
	failures: string[];
	reasoning: string;
}
