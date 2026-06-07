export interface ChildEntry {
	name: string;
	endpoint: string;
	sessionId: string | undefined;
	pid: number;
	process: import("node:child_process").ChildProcess;
	startedAt: number;
}
