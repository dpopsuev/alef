/**
 * Alef Package Manager — npm-backed immutable generation store.
 *
 * Treats ~/.config/alef as an npm project root. npm manages node_modules,
 * lockfile, content-addressed cache, and integrity verification.
 * This module adds a thin generation-snapshot layer on top.
 *
 * Storage:
 *   ~/.config/alef/
 *     package.json          ← adapter dependencies
 *     package-lock.json     ← npm-generated, SHA-512 per package
 *     node_modules/         ← npm-managed adapter installs
 *     generations/N.json    ← immutable snapshots of package-lock.json
 *     current               ← active generation number
 *     local-store/<sha256>/ ← snapshots of file: adapters (not on npm)
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

function parseLockAdapters(lockContent: string): Record<string, string> {
	try {
		const lock = JSON.parse(lockContent) as { packages?: Record<string, { version?: string }> };
		const result: Record<string, string> = {};
		for (const [k, v] of Object.entries(lock.packages ?? {})) {
			if (
				k.startsWith("node_modules/@dpopsuev/") ||
				k.startsWith("node_modules/alef-organ") ||
				k.startsWith("node_modules/alef-adapter")
			) {
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
// Local store (for file: adapters)
// ---------------------------------------------------------------------------

/** Snapshot a local file adapter. Returns the SHA-256 hash used as the store key. */
export function snapshotLocalAdapter(filePath: string): string {
	const content = readFileSync(filePath);
	const hash = createHash("sha256").update(content).digest("hex");
	const storeDir = join(LOCAL_STORE, hash);
	if (!existsSync(storeDir)) {
		mkdirSync(storeDir, { recursive: true });
		copyFileSync(filePath, join(storeDir, basename(filePath)));
	}
	return hash;
}

/** Restore a local adapter from the store. Returns the restored file path. */
export function restoreLocalAdapter(hash: string, fileName: string): string {
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

/** @deprecated Use snapshotLocalAdapter() instead. */
export const snapshotLocalOrgan = snapshotLocalAdapter;

/** @deprecated Use restoreLocalAdapter() instead. */
export const restoreLocalOrgan = restoreLocalAdapter;

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

/** Install an adapter package. */
export async function install(adapter: string, version?: string): Promise<number> {
	init();
	const spec = version ? `${adapter}@${version}` : adapter;
	await runNpm("install", spec);
	return snapshotGeneration();
}

/** Remove an adapter package. */
export async function remove(adapter: string): Promise<number> {
	init();
	await runNpm("uninstall", adapter);
	return snapshotGeneration();
}

/** Upgrade all or specific adapters. */
export async function upgrade(adapters?: string[]): Promise<number> {
	init();
	if (adapters && adapters.length > 0) {
		await runNpm("update", ...adapters);
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

/** Run npm audit against the managed adapter directory. */
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
				organs: parseLockAdapters(gen.lockfileContent),
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

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface SearchResult {
	name: string;
	description: string;
	version: string;
	author: string;
	downloads: number;
}

/**
 * Search npm for packages with the `alef-adapter` (or legacy `alef-organ`) keyword.
 * Optional query further filters by name/description.
 */
export async function search(query: string): Promise<SearchResult[]> {
	const terms = query.trim()
		? `keywords:alef-adapter keywords:alef-organ ${query}`
		: "keywords:alef-adapter keywords:alef-organ";
	const cmd = `npm search ${terms} --json`;
	process.stderr.write(`[alef-pm] ${cmd}\n`);
	const { stdout } = await exec(cmd);
	const raw = JSON.parse(stdout.trim() || "[]") as Array<{
		name?: string;
		description?: string;
		version?: string;
		author?: { name?: string } | string;
		downloads?: { weekly?: number };
	}>;
	return raw.map((r) => ({
		name: r.name ?? "",
		description: r.description ?? "",
		version: r.version ?? "",
		author: typeof r.author === "string" ? r.author : (r.author?.name ?? ""),
		downloads: r.downloads?.weekly ?? 0,
	}));
}

// ---------------------------------------------------------------------------
// SBOM
// ---------------------------------------------------------------------------

export interface SbomComponent {
	SPDXID: string;
	name: string;
	versionInfo: string;
	externalRefs: Array<{ referenceCategory: string; referenceType: string; referenceLocator: string }>;
	checksums: Array<{ algorithm: string; checksumValue: string }>;
}

/**
 * Produce an SPDX-2.3 software bill of materials for all installed adapters.
 * Built-in adapters are identified from the alef monorepo package.json version.
 * Installed adapters are read from the PM_ROOT package-lock.json.
 */
export function sbom(): object {
	const components: SbomComponent[] = [];

	if (existsSync(LOCK_FILE)) {
		const lock = JSON.parse(readFileSync(LOCK_FILE, "utf-8")) as {
			packages?: Record<string, { version?: string; integrity?: string; resolved?: string }>;
		};
		for (const [key, entry] of Object.entries(lock.packages ?? {})) {
			if (!key.startsWith("node_modules/")) continue;
			const name = key.slice("node_modules/".length);
			const version = entry.version ?? "0.0.0";
			const integrity = entry.integrity ?? "";
			const resolved = entry.resolved ?? "";
			const hash = integrity.startsWith("sha512-") ? integrity.slice("sha512-".length) : integrity;
			const spdxId = `SPDXRef-${name.replace(/[^A-Za-z0-9-.]/g, "-")}`;
			components.push({
				SPDXID: spdxId,
				name,
				versionInfo: version,
				externalRefs: [
					{ referenceCategory: "PACKAGE-MANAGER", referenceType: "npm", referenceLocator: resolved },
					{
						referenceCategory: "PACKAGE-MANAGER",
						referenceType: "purl",
						referenceLocator: `pkg:npm/${name}@${version}`,
					},
				],
				checksums: hash ? [{ algorithm: "SHA512", checksumValue: hash }] : [],
			});
		}
	}

	return {
		spdxVersion: "SPDX-2.3",
		dataLicense: "CC0-1.0",
		SPDXID: "SPDXRef-DOCUMENT",
		name: "alef-organs-sbom",
		documentNamespace: `https://alef.local/sbom/${Date.now()}`,
		documentDescribes: components.map((c) => c.SPDXID),
		packages: components,
	};
}

/**
 * Resolve the node_modules path for a named adapter installed via alef-pm.
 * Returns undefined if the adapter is not installed in the PM_ROOT.
 */
export function resolveAdapterPath(name: string): string | undefined {
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

/** @deprecated Use resolveAdapterPath() instead. */
export const resolveOrganPath = resolveAdapterPath;

// ---------------------------------------------------------------------------
// Project-level lockfile — commit organ versions alongside code (like Cargo.lock)
// ---------------------------------------------------------------------------

export interface ProjectLockfile {
	/** Alef version that wrote this lockfile. */
	alef: string;
	/** ISO timestamp of the export. */
	exportedAt: string;
	/** Generation ID at time of export. */
	generationId: number;
	/** Adapter name → exact resolved version. */
	organs: Record<string, string>;
}

const PROJECT_LOCKFILE_NAME = "alef-organs.lock";

/**
 * Export the current adapter generation as a project-level lockfile.
 * Write it to `outputPath` (default: `<cwd>/alef-organs.lock`) so it
 * can be committed to the project repository alongside the code.
 */
export function exportLockfile(cwd = process.cwd(), outputPath?: string): string {
	const genId = currentGenId();
	const lockContent = existsSync(LOCK_FILE) ? readFileSync(LOCK_FILE, "utf-8") : "{}";
	const organs = parseLockAdapters(lockContent);

	const lockfile: ProjectLockfile = {
		alef: process.env.npm_package_version ?? "unknown",
		exportedAt: new Date().toISOString(),
		generationId: genId,
		organs,
	};

	const target = outputPath ?? join(cwd, PROJECT_LOCKFILE_NAME);
	writeFileSync(target, `${JSON.stringify(lockfile, null, 2)}\n`, "utf-8");
	return target;
}

/**
 * Import a project-level lockfile and restore the exact adapter versions.
 * Reads `<cwd>/alef-organs.lock` (or `inputPath`), installs pinned versions,
 * and snapshots the result as a new generation.
 */
export async function importLockfile(cwd = process.cwd(), inputPath?: string): Promise<number> {
	const source = inputPath ?? join(cwd, PROJECT_LOCKFILE_NAME);
	if (!existsSync(source)) {
		throw new Error(`alef-organs.lock not found at ${source}. Run 'alef pm export' first.`);
	}

	const lockfile = JSON.parse(readFileSync(source, "utf-8")) as ProjectLockfile;
	if (!lockfile.organs || typeof lockfile.organs !== "object") {
		throw new Error(`Invalid alef-organs.lock: missing organs field.`);
	}

	init();

	const pinned = Object.entries(lockfile.organs)
		.map(([name, version]) => `${name}@${version}`)
		.join(" ");

	if (pinned.length > 0) {
		await runNpm("install", "--save-exact", ...pinned.split(" "));
	}

	return snapshotGeneration();
}
