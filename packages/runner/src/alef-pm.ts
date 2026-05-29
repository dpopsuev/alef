/**
 * Alef Package Manager — npm-backed immutable generation store.
 *
 * Treats ~/.config/alef as an npm project root. npm manages node_modules,
 * lockfile, content-addressed cache, and integrity verification.
 * This module adds a thin generation-snapshot layer on top.
 *
 * Storage:
 *   ~/.config/alef/
 *     package.json          ← organ dependencies
 *     package-lock.json     ← npm-generated, SHA-512 per package
 *     node_modules/         ← npm-managed organ installs
 *     generations/N.json    ← immutable snapshots of package-lock.json
 *     current               ← active generation number
 *     local-store/<sha256>/ ← snapshots of file: organs (not on npm)
 *
 * Rollback primitive: restore lockfile from generation N, then `npm ci`.
 * npm ci installs exactly what the lockfile says, verified by integrity hash,
 * using ~/.npm/_cacache (no network required if already cached).
 *
 * Prior art: Nix generations, APT 3.2 history-rollback, FreeBSD pkg.
 */

import { exec as execCb } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCb);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PM_ROOT = process.env.ALEF_PM_ROOT ?? join(homedir(), ".config", "alef");
const GEN_DIR = join(PM_ROOT, "generations");
const LOCAL_STORE = join(PM_ROOT, "local-store");
const PACKAGE_JSON = join(PM_ROOT, "package.json");
const LOCK_FILE = join(PM_ROOT, "package-lock.json");
const CURRENT_FILE = join(PM_ROOT, "current");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Generation {
	id: number;
	ts: string;
	lockHash: string;
	lockfileContent: string;
	alef: string;
	parent: number | null;
}

export interface HistoryEntry {
	id: number;
	ts: string;
	alef: string;
	organs: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

export function init(): void {
	mkdirSync(PM_ROOT, { recursive: true });
	mkdirSync(GEN_DIR, { recursive: true });
	mkdirSync(LOCAL_STORE, { recursive: true });

	if (!existsSync(PACKAGE_JSON)) {
		writeFileSync(
			PACKAGE_JSON,
			JSON.stringify({ name: "alef-organs", version: "0.0.0", private: true, dependencies: {} }, null, 2),
		);
	}
}

// ---------------------------------------------------------------------------
// Generation management
// ---------------------------------------------------------------------------

function currentGenId(): number {
	if (!existsSync(CURRENT_FILE)) return 0;
	return parseInt(readFileSync(CURRENT_FILE, "utf-8").trim(), 10) || 0;
}

function nextGenId(): number {
	return currentGenId() + 1;
}

function readGen(id: number): Generation {
	return JSON.parse(readFileSync(join(GEN_DIR, `${id}.json`), "utf-8")) as Generation;
}

function snapshotGeneration(): number {
	const lockContent = existsSync(LOCK_FILE) ? readFileSync(LOCK_FILE, "utf-8") : "{}";
	const lockHash = createHash("sha256").update(lockContent).digest("hex");
	const parent = currentGenId() || null;
	const id = nextGenId();

	const gen: Generation = {
		id,
		ts: new Date().toISOString(),
		lockHash,
		lockfileContent: lockContent,
		alef: process.env.npm_package_version ?? "unknown",
		parent,
	};

	writeFileSync(join(GEN_DIR, `${id}.json`), JSON.stringify(gen, null, 2));
	writeFileSync(CURRENT_FILE, String(id));
	return id;
}

function parseLockOrgans(lockContent: string): Record<string, string> {
	try {
		const lock = JSON.parse(lockContent) as { packages?: Record<string, { version?: string }> };
		const result: Record<string, string> = {};
		for (const [k, v] of Object.entries(lock.packages ?? {})) {
			if (k.startsWith("node_modules/@dpopsuev/") || k.startsWith("node_modules/alef-organ")) {
				const name = basename(k);
				result[name] = v.version ?? "unknown";
			}
		}
		return result;
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Local store (for file: organs)
// ---------------------------------------------------------------------------

/** Snapshot a local file organ. Returns the SHA-256 hash used as the store key. */
export function snapshotLocalOrgan(filePath: string): string {
	const content = readFileSync(filePath);
	const hash = createHash("sha256").update(content).digest("hex");
	const storeDir = join(LOCAL_STORE, hash);
	if (!existsSync(storeDir)) {
		mkdirSync(storeDir, { recursive: true });
		copyFileSync(filePath, join(storeDir, basename(filePath)));
	}
	return hash;
}

/** Restore a local organ from the store. Returns the restored file path. */
export function restoreLocalOrgan(hash: string, fileName: string): string {
	const stored = join(LOCAL_STORE, hash, fileName);
	if (!existsSync(stored)) {
		throw new Error(`local-store: ${hash}/${fileName} not found — was it deleted?`);
	}
	// Verify integrity.
	const content = readFileSync(stored);
	const actual = createHash("sha256").update(content).digest("hex");
	if (actual !== hash) {
		throw new Error(`local-store: ${hash}/${fileName} content hash mismatch — store is corrupted`);
	}
	return stored;
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

export async function runNpm(...args: string[]): Promise<void> {
	if (process.env.ALEF_PM_SKIP_NPM === "1") return;
	const cmd = `npm ${args.join(" ")} --prefix ${PM_ROOT}`;
	process.stderr.write(`[alef-pm] ${cmd}\n`);
	const { stderr } = await exec(cmd);
	if (stderr) process.stderr.write(stderr);
}

/** Install an organ package. */
export async function install(organ: string, version?: string): Promise<number> {
	init();
	const spec = version ? `${organ}@${version}` : organ;
	await runNpm("install", spec);
	return snapshotGeneration();
}

/** Remove an organ package. */
export async function remove(organ: string): Promise<number> {
	init();
	await runNpm("uninstall", organ);
	return snapshotGeneration();
}

/** Upgrade all or specific organs. */
export async function upgrade(organs?: string[]): Promise<number> {
	init();
	if (organs && organs.length > 0) {
		await runNpm("update", ...organs);
	} else {
		await runNpm("update");
	}
	return snapshotGeneration();
}

/**
 * Roll back to generation N.
 * Restores the lockfile and runs `npm ci` — installs exactly what the
 * lockfile specifies, verified by integrity hash, from npm cache (no network).
 */
export async function rollback(n: number): Promise<void> {
	init();
	const gen = readGen(n);
	writeFileSync(LOCK_FILE, gen.lockfileContent);
	await runNpm("ci");
	writeFileSync(CURRENT_FILE, String(n));
	process.stderr.write(`[alef-pm] rolled back to generation ${n}\n`);
}

/** Run npm audit against the managed organ directory. */
export async function audit(): Promise<void> {
	init();
	await runNpm("audit");
}

/** List generation history. */
export function history(): HistoryEntry[] {
	if (!existsSync(GEN_DIR)) return [];
	return readdirSync(GEN_DIR)
		.filter((f) => f.endsWith(".json"))
		.map((f) => {
			const gen = JSON.parse(readFileSync(join(GEN_DIR, f), "utf-8")) as Generation;
			return {
				id: gen.id,
				ts: gen.ts,
				alef: gen.alef,
				organs: parseLockOrgans(gen.lockfileContent),
			};
		})
		.sort((a, b) => b.id - a.id);
}

/**
 * Garbage-collect old generations and unreferenced local-store entries.
 * Keeps `keep` most recent generations (default 10).
 */
export function gc(keep = 10): { removedGenerations: number; removedStoreEntries: number } {
	if (!existsSync(GEN_DIR)) return { removedGenerations: 0, removedStoreEntries: 0 };

	const files = readdirSync(GEN_DIR)
		.filter((f) => f.endsWith(".json"))
		.map((f) => ({ file: f, id: parseInt(f, 10) }))
		.sort((a, b) => b.id - a.id);

	const toRemove = files.slice(keep);
	for (const { file } of toRemove) {
		rmSync(join(GEN_DIR, file));
	}

	// Collect hashes still referenced by remaining generations.
	const kept = files.slice(0, keep);
	const referencedHashes = new Set<string>();
	for (const { file } of kept) {
		const gen = JSON.parse(readFileSync(join(GEN_DIR, file), "utf-8")) as Generation;
		referencedHashes.add(gen.lockHash);
	}

	// Remove local-store entries not referenced.
	let removedStoreEntries = 0;
	if (existsSync(LOCAL_STORE)) {
		for (const entry of readdirSync(LOCAL_STORE)) {
			if (!referencedHashes.has(entry)) {
				rmSync(join(LOCAL_STORE, entry), { recursive: true, force: true });
				removedStoreEntries++;
			}
		}
	}

	return { removedGenerations: toRemove.length, removedStoreEntries };
}

/**
 * Resolve the node_modules path for a named organ installed via alef-pm.
 * Returns undefined if the organ is not installed in the PM_ROOT.
 */
export function resolveOrganPath(name: string): string | undefined {
	const candidates = [
		join(PM_ROOT, "node_modules", name, "src", "organ.ts"),
		join(PM_ROOT, "node_modules", `@dpopsuev`, name, "src", "organ.ts"),
		join(PM_ROOT, "node_modules", name, "src", "index.ts"),
	];
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return undefined;
}
