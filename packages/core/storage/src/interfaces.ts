import type { DisplayBlock } from "@dpopsuev/alef-session/context";
import type { SessionNameSource, SessionStore } from "@dpopsuev/alef-session/storage";

/**
 *
 */
export interface DaemonEntry {
	port: number;
	host: string;
	pid: number;
	sessionId: string;
	cwd: string;
	startedAt: number;
	lastHeartbeat?: number;
	token?: string;
}

/**
 *
 */
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

/**
 *
 */
export interface DaemonRegistry {
	register(entry: DaemonEntry): Promise<void>;
	unregister(sessionId: string): Promise<void>;
	heartbeat(sessionId: string): Promise<void>;
	get(sessionId: string): Promise<DaemonEntry | undefined>;
	list(): Promise<DaemonEntry[]>;
	findByCwd(cwd: string): Promise<DaemonEntry | undefined>;
	findLatest(): Promise<DaemonEntry | undefined>;
	prune(ttlMs?: number): Promise<number>;
}

/**
 *
 */
export interface SummaryStore {
	write(summary: SessionSummary): Promise<void>;
	get(sessionId: string): Promise<SessionSummary | undefined>;
	latest(): Promise<SessionSummary | undefined>;
}

/**
 *
 */
export interface AuthStore {
	get(provider: string): Promise<string | undefined>;
	set(provider: string, key: string): Promise<void>;
	remove(provider: string): Promise<void>;
	list(): Promise<Array<{ provider: string; type: string }>>;
}

/**
 *
 */
export interface SessionListEntry {
	id: string;
	path: string;
	mtime: Date;
	/** Absolute project cwd when known (sqlite). */
	cwd?: string;
	name?: string;
	tags?: string[];
	searchBlob?: string;
}

/**
 *
 */
export interface SessionStoreFactory {
	create(cwd: string): Promise<SessionStore>;
	resume(cwd: string, id: string): Promise<SessionStore>;
	resumeLatest(cwd: string): Promise<SessionStore | null>;
	list(cwd: string): Promise<SessionListEntry[]>;
	/** All sessions across cwd scopes, newest first. */
	listAll(): Promise<SessionListEntry[]>;
	prune(cwd: string): Promise<number>;
}

/**
 *
 */
export interface SessionPreviewProvider {
	getSessionName(sessionId: string): Promise<string | undefined>;
	getSessionNameSource(sessionId: string): Promise<SessionNameSource | undefined>;
	/** Shared transcript projector blocks for the last `maxTurns` user turns (plan/state included). */
	getSessionPreview(sessionId: string, maxTurns: number): Promise<DisplayBlock[]>;
}

/**
 *
 */
export interface StorageFactory {
	daemonRegistry(): DaemonRegistry;
	summaryStore(): SummaryStore;
	authStore(): AuthStore;
	sessionPreview(): SessionPreviewProvider;
	readonly sessions: SessionStoreFactory;
}
