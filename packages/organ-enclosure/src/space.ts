/**
 * Space — isolated agent workspace with copy-on-write semantics.
 *
 * Reads pass through to the real workspace.
 * Writes are captured in the overlay upper layer.
 * Seven verbs: diff, commit, reset, snapshot, restore, exec, destroy.
 *
 * Modelled after ~/Workspace/mirage.
 */

import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile) as {
	(file: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
	(
		file: string,
		args: string[],
		options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
	): Promise<{ stdout: string; stderr: string }>;
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ChangeKind = "created" | "modified" | "deleted";

export interface Change {
	/** Path relative to the workspace root. */
	path: string;
	kind: ChangeKind;
	/** Size in bytes (0 for deleted). */
	size: number;
}

export interface ExecResult {
	exitCode: number;
	output: string;
}

export interface SpaceOptions {
	/**
	 * The real workspace directory — the lower layer.
	 * Reads come from here. Writes go to the overlay upper layer.
	 */
	workspace: string;
	/**
	 * Directory to hold overlay internals (upper/, work/, merged/).
	 * Created automatically. Defaults to a temp dir alongside workspace.
	 */
	overlayDir?: string;
}

// ---------------------------------------------------------------------------
// Space interface
// ---------------------------------------------------------------------------

export interface Space {
	/** The path the agent should use as its working directory (merged view). */
	workDir(): string;

	/** Files changed since the space was created (or last reset/restore). */
	diff(): Promise<Change[]>;

	/**
	 * Promote changes to the real workspace.
	 * If paths is empty, all changed files are promoted.
	 */
	commit(paths?: string[]): Promise<void>;

	/** Discard all overlay changes. The real workspace is untouched. */
	reset(): Promise<void>;

	/** Save current overlay state as a named snapshot. */
	snapshot(name: string): Promise<void>;

	/** Restore a named snapshot, discarding current changes. */
	restore(name: string): Promise<void>;

	/** Names of all saved snapshots. */
	snapshots(): Promise<string[]>;

	/** Run a command inside the space's workDir with optional namespace confinement. */
	exec(command: string[], options?: ExecOptions): Promise<ExecResult>;

	/** Tear down the space and remove all temp directories. */
	destroy(): Promise<void>;
}

export interface ExecOptions {
	/** Timeout in milliseconds. */
	timeoutMs?: number;
	/** Additional environment variables (merged with process.env). */
	env?: Record<string, string>;
	/** Confine the process in Linux namespaces (user+mount+pid+net by default). */
	confine?: boolean;
	/** Memory limit in bytes when confine=true. 0 = unlimited. */
	memoryMaxBytes?: number;
	/** CPU quota in µs per 100ms period. 0 = unlimited. */
	cpuQuotaUs?: number;
}

// ---------------------------------------------------------------------------
// OverlaySpace — fuse-overlayfs implementation
// ---------------------------------------------------------------------------

export class OverlaySpace implements Space {
	private readonly lower: string;
	private readonly upper: string;
	private readonly work: string;
	private readonly merged: string;
	private readonly snapshotsDir: string;
	private mounted = false;

	private constructor(private readonly opts: Required<SpaceOptions>) {
		this.lower = opts.workspace;
		this.upper = join(opts.overlayDir, "upper");
		this.work = join(opts.overlayDir, "work");
		this.merged = join(opts.overlayDir, "merged");
		this.snapshotsDir = join(opts.overlayDir, "snapshots");
	}

	static async create(opts: SpaceOptions): Promise<OverlaySpace> {
		const overlayDir = opts.overlayDir ?? join(opts.workspace, ".enclosure");
		const full: Required<SpaceOptions> = { ...opts, overlayDir };

		for (const sub of ["upper", "work", "merged", "snapshots"]) {
			await mkdir(join(overlayDir, sub), { recursive: true });
		}

		const space = new OverlaySpace(full);
		await space._mount();
		return space;
	}

	workDir(): string {
		return this.merged;
	}

	private async _mount(): Promise<void> {
		if (this.mounted) return;
		await execFileAsync("fuse-overlayfs", [
			"-o",
			`lowerdir=${this.lower},upperdir=${this.upper},workdir=${this.work}`,
			this.merged,
		]);
		this.mounted = true;
	}

	private async _unmount(): Promise<void> {
		if (!this.mounted) return;
		try {
			await execFileAsync("fusermount", ["-u", this.merged]);
		} catch {
			await execFileAsync("umount", [this.merged]);
		}
		this.mounted = false;
	}

	async diff(): Promise<Change[]> {
		return walkUpper(this.upper, this.lower);
	}

	async commit(paths?: string[]): Promise<void> {
		const changes = await this.diff();
		const toCommit = paths?.length ? changes.filter((c) => paths.includes(c.path)) : changes;

		for (const change of toCommit) {
			const src = join(this.upper, change.path);
			const dst = join(this.lower, change.path);
			if (change.kind === "deleted") {
				await rm(dst, { force: true });
			} else {
				await mkdir(join(dst, ".."), { recursive: true });
				await cp(src, dst);
			}
		}
	}

	async reset(): Promise<void> {
		await this._unmount();
		await rm(this.upper, { recursive: true, force: true });
		await rm(this.work, { recursive: true, force: true });
		await mkdir(this.upper, { recursive: true });
		await mkdir(this.work, { recursive: true });
		await this._mount();
	}

	async snapshot(name: string): Promise<void> {
		const dest = join(this.snapshotsDir, name);
		await cp(this.upper, dest, { recursive: true });
	}

	async restore(name: string): Promise<void> {
		const src = join(this.snapshotsDir, name);
		try {
			await stat(src);
		} catch {
			throw new Error(`enclosure: snapshot not found: ${name}`);
		}
		await this.reset();
		await cp(src, this.upper, { recursive: true });
	}

	async snapshots(): Promise<string[]> {
		try {
			const entries = await readdir(this.snapshotsDir, { withFileTypes: true, encoding: "utf-8" });
			return entries.filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			return [];
		}
	}

	async exec(command: string[], options: ExecOptions = {}): Promise<ExecResult> {
		const args = options.confine ? buildUnshareArgs(command, options) : command;
		const [bin, ...rest] = args;

		try {
			const { stdout, stderr } = await execFileAsync(bin, rest, {
				cwd: this.merged,
				env: { ...process.env, ...options.env },
				timeout: options.timeoutMs,
			});
			return { exitCode: 0, output: stdout + stderr };
		} catch (err: unknown) {
			const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
			return {
				exitCode: typeof e.code === "number" ? e.code : 1,
				output: (e.stdout ?? "") + (e.stderr ?? "") || (e.message ?? String(err)),
			};
		}
	}

	async destroy(): Promise<void> {
		await this._unmount();
		await rm(this.opts.overlayDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// StubSpace — in-memory, no I/O, for tests
// ---------------------------------------------------------------------------

export class StubSpace implements Space {
	private readonly _workDir: string;
	private _changes: Change[] = [];
	private _snapshots = new Map<string, Change[]>();

	constructor(workDir: string) {
		this._workDir = workDir;
	}

	workDir(): string {
		return this._workDir;
	}
	async diff(): Promise<Change[]> {
		return [...this._changes];
	}
	async commit(_paths?: string[]): Promise<void> {
		this._changes = [];
	}
	async reset(): Promise<void> {
		this._changes = [];
	}
	async snapshot(name: string): Promise<void> {
		this._snapshots.set(name, [...this._changes]);
	}
	async restore(name: string): Promise<void> {
		const snap = this._snapshots.get(name);
		if (!snap) throw new Error(`enclosure: snapshot not found: ${name}`);
		this._changes = [...snap];
	}
	async snapshots(): Promise<string[]> {
		return [...this._snapshots.keys()];
	}
	async exec(command: string[], _options?: ExecOptions): Promise<ExecResult> {
		return { exitCode: 0, output: `stub: ${command.join(" ")}` };
	}
	async destroy(): Promise<void> {
		this._changes = [];
		this._snapshots.clear();
	}

	/** Test helper: inject a change into the stub. */
	_injectChange(change: Change): void {
		this._changes.push(change);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUnshareArgs(command: string[], opts: ExecOptions): string[] {
	const unshareArgs = ["unshare", "--user", "--map-root-user", "--mount", "--pid", "--fork", "--net"];
	if (opts.memoryMaxBytes || opts.cpuQuotaUs) {
		// cgroup confinement requires --cgroup
		unshareArgs.push("--cgroup");
	}
	return [...unshareArgs, "--", ...command];
}

async function walkUpper(upper: string, lower: string, rel = ""): Promise<Change[]> {
	const changes: Change[] = [];
	let entries: import("node:fs").Dirent<string>[];
	try {
		entries = await readdir(join(upper, rel), { withFileTypes: true, encoding: "utf-8" });
	} catch {
		return changes;
	}

	for (const entry of entries) {
		const relPath = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			changes.push(...(await walkUpper(upper, lower, relPath)));
			continue;
		}
		const upperPath = join(upper, relPath);
		const lowerPath = join(lower, relPath);
		const info = await lstat(upperPath);

		// Overlayfs whiteout: character device rdev=0
		if (isWhiteout(info)) {
			changes.push({ path: relPath, kind: "deleted", size: 0 });
			continue;
		}

		try {
			await lstat(lowerPath);
			changes.push({ path: relPath, kind: "modified", size: info.size });
		} catch {
			changes.push({ path: relPath, kind: "created", size: info.size });
		}
	}

	return changes;
}

function isWhiteout(info: Awaited<ReturnType<typeof lstat>>): boolean {
	// On Linux, overlayfs whiteouts are character devices with rdev=0.
	const mode = Number(info.mode);
	const rdev = Number(info.rdev);
	return (mode & 0o170000) === 0o020000 && rdev === 0;
}
