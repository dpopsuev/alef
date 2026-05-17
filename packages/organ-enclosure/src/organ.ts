/**
 * EnclosureOrgan — CorpusOrgan wrapping Space lifecycle as Motor/Sense events.
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
import type { CorpusHandlerCtx, Nerve, Organ, ToolDefinition } from "@dpopsuev/alef-spine";
import { defineCorpusOrgan } from "@dpopsuev/alef-spine";
import type { DockerSpaceOptions } from "./docker-space.js";
import { DockerSpace } from "./docker-space.js";
import type { ExecOptions, Space } from "./space.js";
import { OverlaySpace, StubSpace } from "./space.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: ToolDefinition[] = [
	{
		name: "enclosure.create",
		description:
			"Create an isolated copy-on-write workspace (Space). Returns a spaceId. Reads come from the real workspace; writes land in the overlay. Use the returned workDir as the working directory for subsequent operations.",
		inputSchema: {
			type: "object",
			properties: {
				workspace: { type: "string", description: "Absolute path to the real workspace directory." },
			},
			required: ["workspace"],
		},
	},
	{
		name: "enclosure.diff",
		description: "List files changed in the overlay since the space was created or last reset.",
		inputSchema: {
			type: "object",
			properties: {
				spaceId: { type: "string" },
			},
			required: ["spaceId"],
		},
	},
	{
		name: "enclosure.commit",
		description: "Promote overlay changes to the real workspace. If paths is omitted, all changes are promoted.",
		inputSchema: {
			type: "object",
			properties: {
				spaceId: { type: "string" },
				paths: {
					type: "array",
					items: { type: "string" },
					description: "Specific paths to commit. Omit to commit all.",
				},
			},
			required: ["spaceId"],
		},
	},
	{
		name: "enclosure.reset",
		description: "Discard all overlay changes. The real workspace is untouched.",
		inputSchema: {
			type: "object",
			properties: { spaceId: { type: "string" } },
			required: ["spaceId"],
		},
	},
	{
		name: "enclosure.snapshot",
		description: "Save the current overlay state as a named snapshot for later restore.",
		inputSchema: {
			type: "object",
			properties: {
				spaceId: { type: "string" },
				name: { type: "string", description: "Snapshot name." },
			},
			required: ["spaceId", "name"],
		},
	},
	{
		name: "enclosure.restore",
		description: "Restore a named snapshot, discarding current overlay changes.",
		inputSchema: {
			type: "object",
			properties: {
				spaceId: { type: "string" },
				name: { type: "string" },
			},
			required: ["spaceId", "name"],
		},
	},
	{
		name: "enclosure.exec",
		description:
			"Run a command inside the space's workDir. Optionally confine the process in Linux namespaces (user+mount+pid+net) with cgroup resource limits.",
		inputSchema: {
			type: "object",
			properties: {
				spaceId: { type: "string" },
				command: { type: "array", items: { type: "string" }, description: "Command and arguments." },
				confine: { type: "boolean", description: "Run inside Linux namespaces (default: false)." },
				timeoutMs: { type: "number", description: "Timeout in milliseconds." },
				memoryMaxBytes: { type: "number", description: "Memory limit in bytes (confine=true only)." },
				cpuQuotaUs: { type: "number", description: "CPU quota µs per 100ms (confine=true only)." },
			},
			required: ["spaceId", "command"],
		},
	},
	{
		name: "enclosure.destroy",
		description: "Tear down the space and remove all overlay directories. Commits nothing.",
		inputSchema: {
			type: "object",
			properties: { spaceId: { type: "string" } },
			required: ["spaceId"],
		},
	},
];

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

export function createEnclosureOrgan(options: EnclosureOrganOptions = {}): Organ {
	// Session-scoped space registry — lives until unmount.
	const spaces = new Map<string, Space>();

	const base = defineCorpusOrgan("enclosure", {
		"enclosure.create": { tool: TOOLS[0], handle: (ctx) => handleCreate(ctx, spaces, options) },
		"enclosure.diff": { tool: TOOLS[1], handle: (ctx) => handleDiff(ctx, spaces) },
		"enclosure.commit": { tool: TOOLS[2], handle: (ctx) => handleCommit(ctx, spaces) },
		"enclosure.reset": { tool: TOOLS[3], handle: (ctx) => handleReset(ctx, spaces) },
		"enclosure.snapshot": { tool: TOOLS[4], handle: (ctx) => handleSnapshot(ctx, spaces) },
		"enclosure.restore": { tool: TOOLS[5], handle: (ctx) => handleRestore(ctx, spaces) },
		"enclosure.exec": { tool: TOOLS[6], handle: (ctx) => handleExec(ctx, spaces) },
		"enclosure.destroy": { tool: TOOLS[7], handle: (ctx) => handleDestroy(ctx, spaces) },
	});

	// Return a wrapper that adds space cleanup on unmount.
	// Uses a new object rather than mutating base.mount (TSK-153).
	const organ: Organ = {
		name: base.name,
		tools: base.tools,
		subscriptions: base.subscriptions,
		directives: base.directives,
		mount(nerve: Nerve): () => void {
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
	ctx: CorpusHandlerCtx,
	spaces: Map<string, Space>,
	opts: EnclosureOrganOptions,
): Promise<Record<string, unknown>> {
	const workspace = String(ctx.payload.workspace ?? "");
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

async function handleDiff(ctx: CorpusHandlerCtx, spaces: Map<string, Space>): Promise<Record<string, unknown>> {
	const space = getSpace(ctx.payload.spaceId, spaces);
	const changes = await space.diff();
	return { changes };
}

async function handleCommit(ctx: CorpusHandlerCtx, spaces: Map<string, Space>): Promise<Record<string, unknown>> {
	const space = getSpace(ctx.payload.spaceId, spaces);
	const paths = Array.isArray(ctx.payload.paths) ? (ctx.payload.paths as string[]) : undefined;
	await space.commit(paths);
	return { committed: paths?.length ?? "all" };
}

async function handleReset(ctx: CorpusHandlerCtx, spaces: Map<string, Space>): Promise<Record<string, unknown>> {
	const space = getSpace(ctx.payload.spaceId, spaces);
	await space.reset();
	return { ok: true };
}

async function handleSnapshot(ctx: CorpusHandlerCtx, spaces: Map<string, Space>): Promise<Record<string, unknown>> {
	const space = getSpace(ctx.payload.spaceId, spaces);
	const name = String(ctx.payload.name ?? "");
	if (!name) throw new Error("enclosure.snapshot: name is required");
	await space.snapshot(name);
	return { ok: true, name };
}

async function handleRestore(ctx: CorpusHandlerCtx, spaces: Map<string, Space>): Promise<Record<string, unknown>> {
	const space = getSpace(ctx.payload.spaceId, spaces);
	const name = String(ctx.payload.name ?? "");
	if (!name) throw new Error("enclosure.restore: name is required");
	await space.restore(name);
	return { ok: true, name };
}

async function handleExec(ctx: CorpusHandlerCtx, spaces: Map<string, Space>): Promise<Record<string, unknown>> {
	const space = getSpace(ctx.payload.spaceId, spaces);
	const command = Array.isArray(ctx.payload.command) ? (ctx.payload.command as string[]) : [];
	if (!command.length) throw new Error("enclosure.exec: command is required");
	const opts: ExecOptions = {
		confine: Boolean(ctx.payload.confine ?? false),
		timeoutMs: typeof ctx.payload.timeoutMs === "number" ? ctx.payload.timeoutMs : undefined,
		memoryMaxBytes: typeof ctx.payload.memoryMaxBytes === "number" ? ctx.payload.memoryMaxBytes : undefined,
		cpuQuotaUs: typeof ctx.payload.cpuQuotaUs === "number" ? ctx.payload.cpuQuotaUs : undefined,
	};
	const result = await space.exec(command, opts);
	if (result.exitCode !== 0) throw new Error(`exit code ${result.exitCode}`);
	return { exitCode: result.exitCode, output: result.output };
}

async function handleDestroy(ctx: CorpusHandlerCtx, spaces: Map<string, Space>): Promise<Record<string, unknown>> {
	const space = getSpace(ctx.payload.spaceId, spaces);
	await space.destroy();
	const spaceId = String(ctx.payload.spaceId ?? "");
	spaces.delete(spaceId);
	return { ok: true };
}
