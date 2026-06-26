import type { SessionStore } from "@dpopsuev/alef-session";

export interface DaemonEntry {
	port: number;
	pid: number;
	sessionId: string;
	cwd: string;
	startedAt: number;
}

export interface SessionSummary {
	id: string;
	model: string;
	started_at: string;
	duration_ms: number;
	turns: number;
	tokens: { input: number; output: number };
	tools: Array<{ name: string; calls: number }>;
	errors: number;
}

export interface DaemonRegistry {
	register(entry: DaemonEntry): Promise<void>;
	unregister(sessionId: string): Promise<void>;
	get(sessionId: string): Promise<DaemonEntry | undefined>;
	list(): Promise<DaemonEntry[]>;
	findByCwd(cwd: string): Promise<DaemonEntry | undefined>;
	findLatest(): Promise<DaemonEntry | undefined>;
	prune(): Promise<number>;
}

export interface SummaryStore {
	write(summary: SessionSummary): Promise<void>;
	get(sessionId: string): Promise<SessionSummary | undefined>;
	latest(): Promise<SessionSummary | undefined>;
}

export interface AuthStore {
	get(provider: string): Promise<string | undefined>;
	set(provider: string, key: string): Promise<void>;
	remove(provider: string): Promise<void>;
	list(): Promise<Array<{ provider: string; type: string }>>;
}

export interface SessionStoreFactory {
	create(cwd: string): Promise<SessionStore>;
	resume(cwd: string, id: string): Promise<SessionStore>;
	resumeLatest(cwd: string): Promise<SessionStore | null>;
	list(cwd: string): Promise<Array<{ id: string; path: string; mtime: Date }>>;
	prune(cwd: string): Promise<number>;
}

export interface SessionPreviewProvider {
	getSessionName(sessionId: string): Promise<string | undefined>;
	getSessionPreview(sessionId: string, maxLines: number): Promise<string[]>;
}

export interface StorageFactory {
	daemonRegistry(): DaemonRegistry;
	summaryStore(): SummaryStore;
	authStore(): AuthStore;
	readonly sessions: SessionStoreFactory;
}
