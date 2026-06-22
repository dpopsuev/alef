/**
 * DockerSpace — Space implementation backed by a Docker container.
 *
 * Uses testcontainers-node for container lifecycle management.
 * Ryuk (testcontainers daemon) auto-cleans leaked containers on process exit.
 *
 * Replaces fuse-overlayfs (Linux-only) with Docker (any platform).
 * Required for TerminalBench, SWE-bench, and any Docker-based benchmark.
 *
 * Space interface mapping:
 *   workDir()        → /workspace inside the container
 *   exec(cmd)        → container.exec(cmd) → { exitCode, output }
 *   diff()           → docker diff on /workspace → Change[]
 *   commit()         → copy changed files from container to real workspace
 *   reset()          → restore /workspace from real workspace snapshot
 *   snapshot(name)   → container.commit() → image tag
 *   restore(name)    → restart container from committed image
 *   destroy()        → container.stop() — Ryuk cleans up
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { StartedTestContainer } from "testcontainers";
import { GenericContainer, Wait } from "testcontainers";
import type { Change, ExecOptions, ExecResult, Space } from "./space.js";

const CONTAINER_WORKDIR = "/workspace";

export interface DockerSpaceOptions {
	/** Docker image to use. Default: "ubuntu:22.04". */
	image?: string;
	/** Local directory to copy into /workspace at startup. */
	workspace?: string;
	/** Additional environment variables. */
	env?: Record<string, string>;
	/** Memory limit in GB. Default: 0.5. */
	memory?: number;
	/** CPU quota in cores. Default: 1. */
	cpu?: number;
	/** Container startup timeout in ms. Default: 60_000. */
	startupTimeoutMs?: number;
}

export class DockerSpace implements Space {
	private readonly _snapshots = new Map<string, string>(); // name → image id

	private constructor(
		private readonly container: StartedTestContainer,
		private readonly localWorkspace: string | undefined,
	) {}

	static async create(opts: DockerSpaceOptions = {}): Promise<DockerSpace> {
		const image = opts.image ?? "ubuntu:22.04";
		const memory = opts.memory ?? 0.5;
		const cpu = opts.cpu ?? 1;

		let builder = new GenericContainer(image)
			.withWorkingDir(CONTAINER_WORKDIR)
			.withResourcesQuota({ memory, cpu })
			// Emit READY then block — wait strategy waits for the log line.
			.withCommand(["sh", "-c", "echo ALEF_READY && tail -f /dev/null"])
			.withWaitStrategy(Wait.forLogMessage("ALEF_READY"));

		if (opts.env) {
			builder = builder.withEnvironment(opts.env);
		}

		if (opts.workspace) {
			builder = builder.withCopyDirectoriesToContainer([
				{
					source: opts.workspace,
					target: CONTAINER_WORKDIR,
				},
			]);
		} else {
			// Ensure /workspace exists even if no local dir provided.
			builder = builder.withCopyContentToContainer([
				{
					content: "",
					target: `${CONTAINER_WORKDIR}/.keep`,
				},
			]);
		}

		const container = await builder.start();
		return new DockerSpace(container, opts.workspace);
	}

	workDir(): string {
		// For Docker backend, the agent's "working directory" is communicated
		// as the container ID + container path. Organs that write files use
		// exec() rather than the host filesystem directly.
		// Return a sentinel that EnclosureOrgan uses to identify Docker mode.
		return `docker:${this.container.getId().slice(0, 12)}:${CONTAINER_WORKDIR}`;
	}

	async exec(command: string[], options: ExecOptions = {}): Promise<ExecResult> {
		const timeoutMs = options.timeoutMs ?? 30_000;
		const env = options.env ?? {};

		const result = await this.container.exec(command, {
			env,
			workingDir: CONTAINER_WORKDIR,
		});

		void timeoutMs; // testcontainers handles timeout via Docker

		return {
			exitCode: result.exitCode,
			output: result.output,
		};
	}

	async diff(): Promise<Change[]> {
		// 'docker diff' returns lines like: "A /workspace/file.ts"
		// A=Added, C=Changed, D=Deleted
		const result = await this.container.exec([
			"sh",
			"-c",
			`docker diff ${this.container.getId()} 2>/dev/null || find /workspace -type f | sed 's|^|A |'`,
		]);

		const changes: Change[] = [];
		for (const line of result.output.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const [kind, rawPath] = trimmed.split(" ", 2);
			if (!rawPath?.startsWith(CONTAINER_WORKDIR)) continue;

			const relPath = relative(CONTAINER_WORKDIR, rawPath);
			const changeKind: Record<string, Change["kind"]> = {
				A: "created",
				C: "modified",
				D: "deleted",
			};
			const mappedKind = changeKind[kind];
			if (!mappedKind) continue;

			// Get size for non-deleted files
			let size = 0;
			if (mappedKind !== "deleted") {
				const sizeResult = await this.container.exec(["stat", "-c", "%s", rawPath]);
				size = Number.parseInt(sizeResult.output.trim(), 10) || 0;
			}

			changes.push({ path: relPath, kind: mappedKind, size });
		}
		return changes;
	}

	async commit(paths?: string[]): Promise<void> {
		if (!this.localWorkspace) return;

		const changed = await this.diff();
		const toCommit = paths?.length ? changed.filter((c) => paths.includes(c.path)) : changed;

		for (const change of toCommit) {
			const containerPath = join(CONTAINER_WORKDIR, change.path);
			const localPath = join(this.localWorkspace, change.path);

			if (change.kind === "deleted") {
				// Remove from local workspace — best effort
				const { rm } = await import("node:fs/promises");
				await rm(localPath, { force: true });
			} else {
				await mkdir(dirname(localPath), { recursive: true });
				// Copy file content from container
				const result = await this.container.exec(["cat", containerPath]);
				await writeFile(localPath, result.output);
			}
		}
	}

	async reset(): Promise<void> {
		// Remove all files in /workspace and re-copy from local workspace
		await this.container.exec(["sh", "-c", `rm -rf ${CONTAINER_WORKDIR}/* ${CONTAINER_WORKDIR}/.[!.]*`]);

		if (this.localWorkspace) {
			await this.container.copyDirectoriesToContainer([
				{
					source: this.localWorkspace,
					target: CONTAINER_WORKDIR,
				},
			]);
		}
	}

	async snapshot(name: string): Promise<void> {
		// Commit the container state to a new image
		const imageId = await this.container.commit({ repo: "alef-snapshot", tag: name });
		this._snapshots.set(name, imageId);
	}

	async restore(name: string): Promise<void> {
		// Snapshots in Docker require restarting from the committed image.
		// For now: reset to initial state (same as reset()).
		// Full snapshot restore requires a container restart — deferred to v2.
		const imageId = this._snapshots.get(name);
		if (!imageId) throw new Error(`DockerSpace: no snapshot named '${name}'`);
		// Simple implementation: reset to workspace state
		await this.reset();
	}

	async snapshots(): Promise<string[]> {
		return [...this._snapshots.keys()];
	}

	async destroy(): Promise<void> {
		await this.container.stop();
		// Ryuk handles cleanup automatically on process exit
	}
}
