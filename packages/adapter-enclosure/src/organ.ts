/**
 * EnclosureOrgan — organ wrapping Space lifecycle as Motor/Sense events.
 *
 * The organ holds a session-scoped Map<spaceId, Space>.
 * The LLM creates a space, gets an ID, operates on it by ID.
 *
 * Motor events handled → Sense events published:
 *   enclosure.create   → spaceId, workDir
 *   enclosure.diff     → changes[]
 *   enclosure.commit   → committed paths count
 *   enclosure.reset    → ok
 *   enclosure.snapshot → ok
 *   enclosure.restore  → ok
 *   enclosure.exec     → exitCode, output
 *   enclosure.destroy  → ok
 */

import { randomUUID } from "node:crypto";
import type { Adapter, Bus, PortDefinition } from "@dpopsuev/alef-kernel";
import { defineAdapter, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";
import type { DockerSpaceOptions } from "./docker-space.js";
import { DockerSpace } from "./docker-space.js";
import type { ExecOptions, Space } from "./space.js";
import { OverlaySpace, StubSpace } from "./space.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

// Named tool consts — individual consts preserve schema types for typedAction() inference.
const CREATE_TOOL = {
	name: "enclosure.create",
	description:
		"Create an isolated copy-on-write workspace (Space). Returns a spaceId. Reads come from the real workspace; writes land in the overlay. Use the returned workDir as the working directory for subsequent operations.",
	inputSchema: z.object({ workspace: z.string().min(1).describe("Absolute path to the real workspace directory.") }),
};
const DIFF_TOOL = {
	name: "enclosure.diff",
	description: "List files changed in the overlay since the space was created or last reset.",
	inputSchema: z.object({ spaceId: z.string().min(1) }),
};
const COMMIT_TOOL = {
	name: "enclosure.commit",
	description: "Promote overlay changes to the real workspace. If paths is omitted, all changes are promoted.",
	inputSchema: z.object({
		spaceId: z.string().min(1),
		paths: z.array(z.string()).optional().describe("Specific paths to commit. Omit to commit all."),
	}),
};
const RESET_TOOL = {
	name: "enclosure.reset",
	description: "Discard all overlay changes. The real workspace is untouched.",
	inputSchema: z.object({ spaceId: z.string().min(1) }),
};
const SNAPSHOT_TOOL = {
	name: "enclosure.snapshot",
	description: "Save the current overlay state as a named snapshot for later restore.",
	inputSchema: z.object({ spaceId: z.string().min(1), name: z.string().min(1).describe("Snapshot name.") }),
};
const RESTORE_TOOL = {
	name: "enclosure.restore",
	description: "Restore a named snapshot, discarding current overlay changes.",
	inputSchema: z.object({ spaceId: z.string().min(1), name: z.string().min(1) }),
};
const EXEC_TOOL = {
	name: "enclosure.exec",
	description:
		"Run a command inside the space's workDir. Optionally confine the process in Linux namespaces (user+mount+pid+net) with cgroup resource limits.",
	inputSchema: z.object({
		spaceId: z.string().min(1),
		command: z.array(z.string()).describe("Command and arguments."),
		confine: z.boolean().optional().describe("Run inside Linux namespaces (default: false)."),
		timeoutMs: z.number().optional().describe("Timeout in milliseconds."),
		memoryMaxBytes: z.number().optional().describe("Memory limit in bytes (confine=true only)."),
		cpuQuotaUs: z.number().optional().describe("CPU quota µs per 100ms (confine=true only)."),
	}),
};
const DESTROY_TOOL = {
	name: "enclosure.destroy",
	description: "Tear down the space and remove all overlay directories. Commits nothing.",
	inputSchema: z.object({ spaceId: z.string().min(1) }),
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface EnclosureOrganOptions {
	/**
	 * Space backend to use. Default: 'overlay' (fuse-overlayfs, Linux).
	 *   'overlay' — fuse-overlayfs, copy-on-write, Linux only
	 *   'docker'  — testcontainers, any platform, benchmark-compatible
	 *   'stub'    — in-memory, no I/O, for tests
	 */
	backend?: "overlay" | "docker" | "stub";
	/** Options for the Docker backend. Required when backend='docker'. */
	docker?: DockerSpaceOptions;
	/** @deprecated Use backend='stub' instead. */
	stub?: boolean;
}

// ---------------------------------------------------------------------------
// Organ
// ---------------------------------------------------------------------------

export function createEnclosureOrgan(options: EnclosureOrganOptions = {}): Adapter {
	// Session-scoped space registry — lives until unmount.
	const spaces = new Map<string, Space>();
	let nerve: Bus | null = null;
	const emitSignal = (type: string, payload: Record<string, unknown>) =>
		nerve?.notification.publish({ type, payload, correlationId: "" });

	const base = defineAdapter(
		"enclosure",
		{
			motor: {
				"enclosure.create": typedAction(CREATE_TOOL, async (ctx) => {
					const { spaceId, workDir } = await handleCreate(ctx, spaces, options);
					emitSignal("enclosure.status", { text: `space: ${spaceId}`, active: true });
					return withDisplay(
						{ spaceId, workDir },
						{ text: `Created enclosure ${spaceId} at ${workDir}`, mimeType: "text/plain" },
					);
				}),
				"enclosure.diff": typedAction(DIFF_TOOL, async (ctx) => {
					const result = await handleDiff(ctx, spaces);
					const changes = result.changes as string[];
					return withDisplay(
						{ changes },
						{ text: `${changes.length} change(s) in enclosure ${ctx.payload.spaceId}`, mimeType: "text/plain" },
					);
				}),
				"enclosure.commit": typedAction(COMMIT_TOOL, async (ctx) => {
					const { committed } = await handleCommit(ctx, spaces);
					return withDisplay(
						{ committed },
						{
							text: `Committed ${committed} path(s) for enclosure ${ctx.payload.spaceId}`,
							mimeType: "text/plain",
						},
					);
				}),
				"enclosure.reset": typedAction(RESET_TOOL, async (ctx) => {
					await handleReset(ctx, spaces);
					return withDisplay(
						{ ok: true },
						{ text: `Reset enclosure ${ctx.payload.spaceId}`, mimeType: "text/plain" },
					);
				}),
				"enclosure.snapshot": typedAction(SNAPSHOT_TOOL, async (ctx) => {
					const { name } = await handleSnapshot(ctx, spaces);
					return withDisplay(
						{ ok: true, name },
						{ text: `Snapshot "${name}" saved for enclosure ${ctx.payload.spaceId}`, mimeType: "text/plain" },
					);
				}),
				"enclosure.restore": typedAction(RESTORE_TOOL, async (ctx) => {
					const { name } = await handleRestore(ctx, spaces);
					return withDisplay(
						{ ok: true, name },
						{ text: `Restored snapshot "${name}" for enclosure ${ctx.payload.spaceId}`, mimeType: "text/plain" },
					);
				}),
				"enclosure.exec": typedAction(EXEC_TOOL, async (ctx) => {
					const { exitCode, output } = await handleExec(ctx, spaces);
					return withDisplay(
						{ exitCode, output },
						{ text: `exec exit ${exitCode}: ${ctx.payload.command.join(" ")}`, mimeType: "text/plain" },
					);
				}),
				"enclosure.destroy": typedAction(DESTROY_TOOL, async (ctx) => {
					await handleDestroy(ctx, spaces);
					emitSignal("enclosure.status", { text: "", active: false });
					return withDisplay(
						{ ok: true },
						{ text: `Destroyed enclosure ${ctx.payload.spaceId}`, mimeType: "text/plain" },
					);
				}),
			},
		},
		{
			onMount: (n: Bus) => {
				nerve = n;
			},
			contributions: {
				tui: {
					signals: {
						"enclosure.status": (payload, ui) => {
							ui.setStatus(String(payload.text ?? ""));
						},
					},
				},
			},
			description: "Isolated workspace overlay: create, exec, diff, commit, snapshot, restore, destroy.",
			directives: [
				"Use enclosure.create to open a workspace, enclosure.exec to run commands inside it, enclosure.diff/commit to manage changes, and enclosure.destroy when done.",
			],
		},
	);

	// Return a wrapper that adds space cleanup on unmount.
	// Uses a new object rather than mutating base.mount.
	const organ: Adapter = {
		name: base.name,
		description: base.description,
		tools: base.tools,
		subscriptions: base.subscriptions,
		sources: base.sources,
		directives: base.directives,
		contributions: {
			port: {
				name: "enclosure",
				eventPattern: "motor/enclosure.",
				cardinality: "zero-or-one",
			} satisfies PortDefinition,
		},
		mount(nerve: Bus): () => void {
			const unmount = base.mount(nerve);
			return () => {
				unmount();
				for (const space of spaces.values()) void space.destroy();
				spaces.clear();
			};
		},
	};

	return organ;
}

// ---------------------------------------------------------------------------
// Handlers — return payloads or throw; framework handles Sense publishing
// ---------------------------------------------------------------------------

function getSpace(spaceId: unknown, spaces: Map<string, Space>): Space {
	const space = typeof spaceId === "string" ? spaces.get(spaceId) : undefined;
	if (!space) throw new Error(`enclosure: unknown spaceId: ${String(spaceId)}`);
	return space;
}

async function handleCreate(
	ctx: { payload: { workspace: string } },
	spaces: Map<string, Space>,
	opts: EnclosureOrganOptions,
): Promise<Record<string, unknown>> {
	const { workspace } = ctx.payload;
	if (!workspace) throw new Error("enclosure.create: workspace is required");
	const spaceId = randomUUID();

	const backend = opts.backend ?? (opts.stub ? "stub" : "overlay");
	let space: Space;
	if (backend === "docker") {
		space = await DockerSpace.create({ ...opts.docker, workspace });
	} else if (backend === "stub") {
		space = new StubSpace(workspace);
	} else {
		space = await OverlaySpace.create({ workspace });
	}

	spaces.set(spaceId, space);
	return { spaceId, workDir: space.workDir() };
}

async function handleDiff(
	ctx: { payload: { spaceId: string } },
	spaces: Map<string, Space>,
): Promise<Record<string, unknown>> {
	const space = getSpace(ctx.payload.spaceId, spaces);
	const changes = await space.diff();
	return { changes };
}

async function handleCommit(
	ctx: { payload: { spaceId: string; paths?: string[] } },
	spaces: Map<string, Space>,
): Promise<Record<string, unknown>> {
	const space = getSpace(ctx.payload.spaceId, spaces);
	const { paths } = ctx.payload;
	await space.commit(paths);
	return { committed: paths?.length ?? "all" };
}

async function handleReset(
	ctx: { payload: { spaceId: string } },
	spaces: Map<string, Space>,
): Promise<Record<string, unknown>> {
	const space = getSpace(ctx.payload.spaceId, spaces);
	await space.reset();
	return { ok: true };
}

async function handleSnapshot(
	ctx: { payload: { spaceId: string; name: string } },
	spaces: Map<string, Space>,
): Promise<Record<string, unknown>> {
	const space = getSpace(ctx.payload.spaceId, spaces);
	const { name } = ctx.payload;
	if (!name) throw new Error("enclosure.snapshot: name is required");
	await space.snapshot(name);
	return { ok: true, name };
}

async function handleRestore(
	ctx: { payload: { spaceId: string; name: string } },
	spaces: Map<string, Space>,
): Promise<Record<string, unknown>> {
	const space = getSpace(ctx.payload.spaceId, spaces);
	const { name } = ctx.payload;
	if (!name) throw new Error("enclosure.restore: name is required");
	await space.restore(name);
	return { ok: true, name };
}

async function handleExec(
	ctx: {
		payload: {
			spaceId: string;
			command: string[];
			confine?: boolean;
			timeoutMs?: number;
			memoryMaxBytes?: number;
			cpuQuotaUs?: number;
		};
	},
	spaces: Map<string, Space>,
): Promise<Record<string, unknown>> {
	const space = getSpace(ctx.payload.spaceId, spaces);
	const { command, confine, timeoutMs, memoryMaxBytes, cpuQuotaUs } = ctx.payload;
	if (!command.length) throw new Error("enclosure.exec: command is required");
	const opts: ExecOptions = { confine: confine ?? false, timeoutMs, memoryMaxBytes, cpuQuotaUs };
	const result = await space.exec(command, opts);
	if (result.exitCode !== 0) throw new Error(`exit code ${result.exitCode}`);
	return { exitCode: result.exitCode, output: result.output };
}

async function handleDestroy(
	ctx: { payload: { spaceId: string } },
	spaces: Map<string, Space>,
): Promise<Record<string, unknown>> {
	const space = getSpace(ctx.payload.spaceId, spaces);
	await space.destroy();
	spaces.delete(ctx.payload.spaceId);
	return { ok: true };
}
