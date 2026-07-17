import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelsDevEntry } from "./models-snapshot.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 3_600_000;

const CACHE_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "alef");
const CACHE_PATH = join(CACHE_DIR, "models-dev.json");

const FETCH_TIMEOUT_MS = 5_000;

/** Check whether the local cache file exists and is within TTL. */
function isCacheFresh(): boolean {
	try {
		const raw = readFileSync(CACHE_PATH, "utf-8");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON structure validated by typeof check below
		const data = JSON.parse(raw) as { fetchedAt?: number };
		return typeof data.fetchedAt === "number" && Date.now() - data.fetchedAt < CACHE_TTL_MS;
	} catch {
		return false;
	}
}

/** Read cached models.dev entries from disk. */
function readCache(): ModelsDevEntry[] | null {
	try {
		const raw = readFileSync(CACHE_PATH, "utf-8");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON structure validated by Array.isArray check below
		const data = JSON.parse(raw) as { entries?: ModelsDevEntry[] };
		return Array.isArray(data.entries) ? data.entries : null;
	} catch {
		return null;
	}
}

/** Persist fetched entries to local cache (best-effort). */
function writeCache(entries: ModelsDevEntry[]): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), entries }));
	} catch {
		// cache write is best-effort
	}
}

/** Fetch models.dev/api.json entries, using local cache when fresh. */
export async function fetchModelsDev(): Promise<ModelsDevEntry[]> {
	if (isCacheFresh()) {
		const cached = readCache();
		if (cached) return cached;
	}

	try {
		const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- models.dev returns a JSON array of model entries
		const entries = (await res.json()) as ModelsDevEntry[];
		writeCache(entries);
		return entries;
	} catch {
		const cached = readCache();
		if (cached) return cached;
		return [];
	}
}
