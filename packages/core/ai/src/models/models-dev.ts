import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { ModelsDevEntry } from "./models-snapshot.js";

/** Narrow an unknown value to a plain object, rejecting arrays and null. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flatten the provider-keyed models.dev payload into `provider/model` entries.
 * Every level is validated at runtime rather than cast -- models.dev's shape is
 * out of our control, and a single malformed provider/model must not take down
 * the whole merge (see the claude-sonnet-5 outage this replaced).
 */
function flattenModelsDevPayload(payload: unknown): ModelsDevEntry[] {
	if (!isRecord(payload)) {
		traceEvent("models:parse:bad-shape", { reason: "payload is not an object" });
		return [];
	}

	const entries: ModelsDevEntry[] = [];
	let skippedProviders = 0;
	let skippedModels = 0;

	for (const [provider, providerData] of Object.entries(payload)) {
		if (!isRecord(providerData) || !isRecord(providerData.models)) {
			skippedProviders++;
			continue;
		}
		for (const [modelId, model] of Object.entries(providerData.models)) {
			if (!isRecord(model)) {
				skippedModels++;
				continue;
			}
			entries.push({
				id: `${provider}/${modelId}`,
				name: typeof model.name === "string" ? model.name : modelId,
				reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
				tool_call: typeof model.tool_call === "boolean" ? model.tool_call : undefined,
				limit: isRecord(model.limit) ? model.limit : undefined,
				cost: isRecord(model.cost) ? model.cost : undefined,
				modalities: isRecord(model.modalities) ? model.modalities : undefined,
			});
		}
	}

	if (skippedProviders > 0 || skippedModels > 0) {
		traceEvent("models:parse:skipped", { skippedProviders, skippedModels });
	}
	return entries;
}

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
		if (cached) {
			traceEvent("models:fetch:cache-hit", { count: cached.length });
			return cached;
		}
	}

	let res: Response;
	try {
		res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (err) {
		traceEvent("models:fetch:network-error", { err: String(err) });
		return readCache() ?? [];
	}

	if (!res.ok) {
		traceEvent("models:fetch:bad-status", { status: res.status });
		return readCache() ?? [];
	}

	let payload: unknown;
	try {
		payload = await res.json();
	} catch (err) {
		traceEvent("models:fetch:invalid-json", { err: String(err) });
		return readCache() ?? [];
	}

	const entries = flattenModelsDevPayload(payload);
	if (entries.length === 0) {
		traceEvent("models:fetch:empty-payload");
		return readCache() ?? [];
	}

	writeCache(entries);
	traceEvent("models:fetch:success", { count: entries.length });
	return entries;
}
