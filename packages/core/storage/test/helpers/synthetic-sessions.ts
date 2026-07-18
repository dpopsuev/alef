/**
 * Synthetic session corpus for picker / preview performance and integration tests.
 *
 * Creates real SQLite sessions with realistic event bus/type patterns (boot noise,
 * user/assistant turns, tool commands, chunk spam) so benches exercise the same
 * getSessionPreview → projectTranscriptSlice path as production.
 */
import type { Client } from "@libsql/client";
import { makeTestDatabase } from "../../src/sqlite/database.js";
import { SqliteSessionStore } from "../../src/sqlite/session.js";
import { SqliteStorageFactory } from "../../src/factory.js";
import type { SessionListEntry, SessionPreviewProvider } from "../../src/interfaces.js";

/** Session weight — drives turn count, tool density, and noise. */
export type SessionSizeProfile = "tiny" | "medium" | "heavy" | "noisy";

/** One session to materialize. */
export interface SyntheticSessionSpec {
	name: string;
	profile: SessionSizeProfile;
	tags?: readonly string[];
	cwd?: string;
	/** Override turn count from profile defaults. */
	turns?: number;
	/** Deterministic content seed (default: hash of name). */
	seed?: number;
}

/** Corpus build options. */
export interface SyntheticCorpusOptions {
	/** Working directory for most sessions (list scope). */
	cwd: string;
	/**
	 * Either an explicit list of specs, or a count — when a count, profiles cycle
	 * through {@link profileMix}.
	 */
	sessions: number | readonly SyntheticSessionSpec[];
	/** Profile cycle when `sessions` is a number. */
	profileMix?: readonly SessionSizeProfile[];
	/** Base event timestamp (ms). */
	baseTimestamp?: number;
	/**
	 * Extra cwd used for a fraction of sessions (scope="all" picker tests).
	 * Every 5th session lands here when set.
	 */
	altCwd?: string;
	/** Optional existing client — skips makeTestDatabase when provided. */
	client?: Client;
}

/** Generated event before SQL insert. */
export interface SyntheticEvent {
	bus: string;
	type: string;
	correlationId: string;
	payload: Record<string, unknown>;
	timestamp: number;
}

/** One materialized session in the corpus. */
export interface SyntheticSessionInfo {
	id: string;
	name: string;
	profile: SessionSizeProfile;
	cwd: string;
	eventCount: number;
	turnCount: number;
	tags: readonly string[];
}

/** Live corpus handle — real factory + preview provider + cleanup. */
export interface SyntheticCorpus {
	client: Client;
	factory: SqliteStorageFactory;
	cwd: string;
	sessions: readonly SyntheticSessionInfo[];
	preview: SessionPreviewProvider;
	/** Same as production session list for cwd. */
	list: () => Promise<SessionListEntry[]>;
	listAll: () => Promise<SessionListEntry[]>;
	cleanup: () => void;
	/** Aggregate stats for bench logs. */
	stats: {
		sessionCount: number;
		totalEvents: number;
		byProfile: Record<SessionSizeProfile, number>;
	};
}

const DEFAULT_PROFILE_MIX: readonly SessionSizeProfile[] = [
	"tiny",
	"medium",
	"heavy",
	"noisy",
	"medium",
	"heavy",
	"tiny",
	"medium",
];

const PROFILE_TURNS: Record<SessionSizeProfile, number> = {
	tiny: 3,
	medium: 10,
	heavy: 28,
	noisy: 12,
};

const TOOL_NAMES = [
	"fs.read",
	"fs.write",
	"shell.exec",
	"code-intel.symbols",
	"agent.spawn",
	"web.search",
	"git.status",
] as const;

const ADAPTERS = ["fs", "shell", "llm", "code-intel", "web", "git", "agent", "skills"] as const;

const TOPIC_STEMS = [
	"refactor picker debounce",
	"fix native ABI mismatch",
	"trace session resume hang",
	"tighten preview projection",
	"benchmark scroll paint path",
	"wire colon command chrome",
	"stabilize better-sqlite3 rebuild",
	"document Node 22 pin",
] as const;

/** Mulberry32 — small deterministic PRNG. */
export function createSeededRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function hashString(value: string): number {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function pick<T>(rng: () => number, items: readonly T[]): T {
	return items[Math.floor(rng() * items.length)]!;
}

function lorem(rng: () => number, words: number): string {
	const vocab = [
		"session",
		"preview",
		"debounce",
		"sqlite",
		"projection",
		"transcript",
		"adapter",
		"render",
		"scroll",
		"cache",
		"fingerprint",
		"neighbor",
		"picker",
		"latency",
		"throughput",
	];
	const out: string[] = [];
	for (let i = 0; i < words; i++) out.push(pick(rng, vocab));
	return out.join(" ");
}

/** Profile → turn count (respects optional override). */
export function resolveTurnCount(profile: SessionSizeProfile, override?: number): number {
	return override ?? PROFILE_TURNS[profile];
}

/**
 * Build a realistic event timeline for one session (not yet persisted).
 * Mirrors production bus/type patterns used by projectTranscriptSlice.
 */
export function generateSyntheticEvents(opts: {
	profile: SessionSizeProfile;
	turns: number;
	seed: number;
	baseTimestamp: number;
	topic: string;
}): SyntheticEvent[] {
	const rng = createSeededRng(opts.seed);
	const events: SyntheticEvent[] = [];
	let ts = opts.baseTimestamp;

	const bootCount = opts.profile === "noisy" ? 24 : opts.profile === "heavy" ? 10 : 4;
	for (let i = 0; i < bootCount; i++) {
		events.push({
			bus: "event",
			type: "adapter.loaded",
			correlationId: "boot",
			payload: { name: ADAPTERS[i % ADAPTERS.length] },
			timestamp: ts++,
		});
	}

	for (let turn = 0; turn < opts.turns; turn++) {
		const corr = `t${turn + 1}`;
		const userText =
			turn === 0
				? `${opts.topic} — start from the failing path and keep the change small.`
				: `Follow-up ${turn}: ${lorem(rng, 8 + Math.floor(rng() * 12))}`;

		events.push({
			bus: "event",
			type: "llm.input",
			correlationId: corr,
			payload: { text: userText, sender: "human" },
			timestamp: ts++,
		});

		const chunkCount =
			opts.profile === "heavy" ? 8 + Math.floor(rng() * 12) : opts.profile === "noisy" ? 6 + Math.floor(rng() * 8) : Math.floor(rng() * 3);
		for (let c = 0; c < chunkCount; c++) {
			events.push({
				bus: "notification",
				type: "llm.chunk",
				correlationId: corr,
				payload: { text: `chunk-${c} ` },
				timestamp: ts++,
			});
		}

		const toolBudget =
			opts.profile === "heavy" ? 2 + Math.floor(rng() * 3) : opts.profile === "tiny" ? (rng() < 0.4 ? 1 : 0) : 1 + Math.floor(rng() * 2);

		for (let t = 0; t < toolBudget; t++) {
			const tool = pick(rng, TOOL_NAMES);
			const summary =
				tool === "fs.read" || tool === "fs.write"
					? `/tmp/synth/${opts.topic.replace(/\s+/g, "-")}-${turn}-${t}.ts`
					: tool === "shell.exec"
						? `npm run check:fast #${turn}`
						: tool === "agent.spawn"
							? "coding"
							: lorem(rng, 4);
			events.push({
				bus: "command",
				type: tool,
				correlationId: corr,
				payload:
					tool.startsWith("fs.")
						? { path: summary }
						: tool === "shell.exec"
							? { command: summary }
							: tool === "agent.spawn"
								? { blueprintPath: summary }
								: { query: summary },
				timestamp: ts++,
			});
		}

		const answerWords =
			opts.profile === "heavy" ? 80 + Math.floor(rng() * 120) : opts.profile === "tiny" ? 12 + Math.floor(rng() * 20) : 30 + Math.floor(rng() * 50);
		const assistantText = [
			`Working on ${opts.topic} (turn ${turn + 1}).`,
			lorem(rng, answerWords),
			opts.profile === "heavy" ? `\n\`\`\`ts\nexport function synth${turn}() {\n  return ${Math.floor(rng() * 1000)};\n}\n\`\`\`` : "",
		]
			.filter(Boolean)
			.join("\n");

		events.push({
			bus: "notification",
			type: "llm.result",
			correlationId: corr,
			payload: { text: assistantText, role: "assistant" },
			timestamp: ts++,
		});
	}

	if (opts.profile === "noisy") {
		for (let i = 0; i < 40; i++) {
			events.push({
				bus: "event",
				type: "adapter.loaded",
				correlationId: `post-boot-${i}`,
				payload: { name: `noise-${i}` },
				timestamp: ts++,
			});
		}
	}

	return events;
}

/** Expand count → concrete specs with cycling profiles. */
export function expandSessionSpecs(opts: SyntheticCorpusOptions): SyntheticSessionSpec[] {
	if (typeof opts.sessions !== "number") return [...opts.sessions];
	const count = opts.sessions;
	const mix = opts.profileMix ?? DEFAULT_PROFILE_MIX;
	const specs: SyntheticSessionSpec[] = [];
	for (let i = 0; i < count; i++) {
		const profile = mix[i % mix.length]!;
		const topic = TOPIC_STEMS[i % TOPIC_STEMS.length]!;
		specs.push({
			name: `${topic} #${i + 1}`,
			profile,
			tags: profile === "heavy" ? ["perf", "picker"] : profile === "noisy" ? ["noise"] : ["synth"],
			cwd: opts.altCwd && i % 5 === 4 ? opts.altCwd : opts.cwd,
			seed: hashString(`${topic}:${i}`),
		});
	}
	return specs;
}

const INSERT_CHUNK = 80;

async function bulkInsertEvents(client: Client, sessionId: string, events: readonly SyntheticEvent[]): Promise<void> {
	for (let offset = 0; offset < events.length; offset += INSERT_CHUNK) {
		const slice = events.slice(offset, offset + INSERT_CHUNK);
		await client.batch(
			slice.map((event) => ({
				sql: `INSERT INTO events (session_id, bus, type, correlation_id, payload,
					timestamp, elapsed, hash, actor_address, actor_type, adapter, turn_number, version)
				VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, 0)`,
				args: [
					sessionId,
					event.bus,
					event.type,
					event.correlationId,
					JSON.stringify(event.payload),
					event.timestamp,
					event.type.includes(".") ? event.type.slice(0, event.type.indexOf(".")) : null,
				],
			})),
			"write",
		);
	}
}

function searchBlobFromEvents(events: readonly SyntheticEvent[], name: string, tags: readonly string[]): string {
	const texts: string[] = [name, ...tags];
	for (const event of events) {
		if (event.type === "llm.input" || event.type === "llm.result") {
			const text = event.payload.text;
			if (typeof text === "string") texts.push(text.slice(0, 200));
		}
	}
	return texts.join(" ").slice(0, 4000);
}

/**
 * Materialize a synthetic corpus into a temp (or provided) SQLite database.
 */
export async function createSyntheticCorpus(opts: SyntheticCorpusOptions): Promise<SyntheticCorpus> {
	const owned = opts.client ? undefined : await makeTestDatabase();
	const client = opts.client ?? owned!.client;
	const factory = new SqliteStorageFactory(client);
	const baseTimestamp = opts.baseTimestamp ?? Date.UTC(2026, 6, 18, 12, 0, 0);
	const specs = expandSessionSpecs(opts);
	const sessions: SyntheticSessionInfo[] = [];
	const byProfile: Record<SessionSizeProfile, number> = {
		tiny: 0,
		medium: 0,
		heavy: 0,
		noisy: 0,
	};
	let totalEvents = 0;

	for (let index = 0; index < specs.length; index++) {
		const spec = specs[index]!;
		const cwd = spec.cwd ?? opts.cwd;
		const store = await SqliteSessionStore.create(client, cwd);
		const turns = resolveTurnCount(spec.profile, spec.turns);
		const seed = spec.seed ?? hashString(spec.name);
		const topic = TOPIC_STEMS[index % TOPIC_STEMS.length]!;
		const events = generateSyntheticEvents({
			profile: spec.profile,
			turns,
			seed,
			baseTimestamp: baseTimestamp + index * 60_000,
			topic,
		});

		await bulkInsertEvents(client, store.id, events);

		const tags = [...(spec.tags ?? ["synth"])];
		await store.setName(spec.name, { source: "user" });
		await store.setTags(tags, { source: "user" });
		await store.setSearchBlob(searchBlobFromEvents(events, spec.name, tags));

		// Bump mtime ordering — newer sessions last in generation appear first in list DESC.
		await client.execute({
			sql: "UPDATE sessions SET updated_at = ? WHERE id = ?",
			args: [baseTimestamp + index * 1000, store.id],
		});

		sessions.push({
			id: store.id,
			name: spec.name,
			profile: spec.profile,
			cwd,
			eventCount: events.length,
			turnCount: turns,
			tags,
		});
		byProfile[spec.profile]++;
		totalEvents += events.length;
	}

	return {
		client,
		factory,
		cwd: opts.cwd,
		sessions,
		preview: factory.sessionPreview(),
		list: () => factory.sessions.list(opts.cwd),
		listAll: () => factory.sessions.listAll(),
		cleanup: () => {
			owned?.cleanup();
		},
		stats: {
			sessionCount: sessions.length,
			totalEvents,
			byProfile,
		},
	};
}
