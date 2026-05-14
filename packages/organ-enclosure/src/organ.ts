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
import type { CorpusNerve, CorpusOrgan, MotorEvent, SenseEvent, ToolDefinition } from "@dpopsuev/alef-spine";
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
	 * When true, uses StubSpace instead of OverlaySpace.
	 * Useful for tests on systems without fuse-overlayfs.
	 */
	stub?: boolean;
}

// ---------------------------------------------------------------------------
// Organ
// ---------------------------------------------------------------------------

export function createEnclosureOrgan(options: EnclosureOrganOptions = {}): CorpusOrgan {
	return {
		kind: "corpus",
		name: "enclosure",
		tools: TOOLS,

		mount(nerve: CorpusNerve): () => void {
			// Session-scoped space registry — lives until unmount.
			const spaces = new Map<string, Space>();

			const handlers: Array<() => void> = [
				nerve.motor.subscribe("enclosure.create", (e) => handleCreate(e, nerve, spaces, options)),
				nerve.motor.subscribe("enclosure.diff", (e) => handleDiff(e, nerve, spaces)),
				nerve.motor.subscribe("enclosure.commit", (e) => handleCommit(e, nerve, spaces)),
				nerve.motor.subscribe("enclosure.reset", (e) => handleReset(e, nerve, spaces)),
				nerve.motor.subscribe("enclosure.snapshot", (e) => handleSnapshot(e, nerve, spaces)),
				nerve.motor.subscribe("enclosure.restore", (e) => handleRestore(e, nerve, spaces)),
				nerve.motor.subscribe("enclosure.exec", (e) => handleExec(e, nerve, spaces)),
				nerve.motor.subscribe("enclosure.destroy", (e) => handleDestroy(e, nerve, spaces)),
			];

			return () => {
				for (const off of handlers) off();
				// Best-effort cleanup of any surviving spaces.
				for (const space of spaces.values()) void space.destroy();
				spaces.clear();
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function sense(
	motor: MotorEvent,
	payload: Record<string, unknown>,
	isError = false,
	errorMessage?: string,
): SenseEvent {
	const toolCallId = typeof motor.payload.toolCallId === "string" ? motor.payload.toolCallId : undefined;
	return {
		type: motor.type,
		correlationId: motor.correlationId,
		timestamp: Date.now(),
		payload: toolCallId ? { ...payload, toolCallId } : payload,
		isError,
		errorMessage,
	};
}

function err(motor: MotorEvent, message: string): SenseEvent {
	const toolCallId = typeof motor.payload.toolCallId === "string" ? motor.payload.toolCallId : undefined;
	return {
		type: motor.type,
		correlationId: motor.correlationId,
		timestamp: Date.now(),
		payload: toolCallId ? { toolCallId } : {},
		isError: true,
		errorMessage: message,
	};
}

function getSpace(spaceId: unknown, spaces: Map<string, Space>): Space | undefined {
	return typeof spaceId === "string" ? spaces.get(spaceId) : undefined;
}

async function handleCreate(
	motor: MotorEvent,
	nerve: CorpusNerve,
	spaces: Map<string, Space>,
	opts: EnclosureOrganOptions,
): Promise<void> {
	const workspace = String(motor.payload.workspace ?? "");
	if (!workspace) {
		nerve.sense.publish(err(motor, "enclosure.create: workspace is required"));
		return;
	}
	try {
		const spaceId = randomUUID();
		const space = opts.stub ? new StubSpace(workspace) : await OverlaySpace.create({ workspace });
		spaces.set(spaceId, space);
		nerve.sense.publish(sense(motor, { spaceId, workDir: space.workDir() }));
	} catch (e) {
		nerve.sense.publish(err(motor, `enclosure.create: ${e instanceof Error ? e.message : String(e)}`));
	}
}

async function handleDiff(motor: MotorEvent, nerve: CorpusNerve, spaces: Map<string, Space>): Promise<void> {
	const space = getSpace(motor.payload.spaceId, spaces);
	if (!space) {
		nerve.sense.publish(err(motor, `enclosure: unknown spaceId: ${motor.payload.spaceId}`));
		return;
	}
	try {
		const changes = await space.diff();
		nerve.sense.publish(sense(motor, { changes }));
	} catch (e) {
		nerve.sense.publish(err(motor, `enclosure.diff: ${e instanceof Error ? e.message : String(e)}`));
	}
}

async function handleCommit(motor: MotorEvent, nerve: CorpusNerve, spaces: Map<string, Space>): Promise<void> {
	const space = getSpace(motor.payload.spaceId, spaces);
	if (!space) {
		nerve.sense.publish(err(motor, `enclosure: unknown spaceId: ${motor.payload.spaceId}`));
		return;
	}
	try {
		const paths = Array.isArray(motor.payload.paths) ? (motor.payload.paths as string[]) : undefined;
		await space.commit(paths);
		nerve.sense.publish(sense(motor, { committed: paths?.length ?? "all" }));
	} catch (e) {
		nerve.sense.publish(err(motor, `enclosure.commit: ${e instanceof Error ? e.message : String(e)}`));
	}
}

async function handleReset(motor: MotorEvent, nerve: CorpusNerve, spaces: Map<string, Space>): Promise<void> {
	const space = getSpace(motor.payload.spaceId, spaces);
	if (!space) {
		nerve.sense.publish(err(motor, `enclosure: unknown spaceId: ${motor.payload.spaceId}`));
		return;
	}
	try {
		await space.reset();
		nerve.sense.publish(sense(motor, { ok: true }));
	} catch (e) {
		nerve.sense.publish(err(motor, `enclosure.reset: ${e instanceof Error ? e.message : String(e)}`));
	}
}

async function handleSnapshot(motor: MotorEvent, nerve: CorpusNerve, spaces: Map<string, Space>): Promise<void> {
	const space = getSpace(motor.payload.spaceId, spaces);
	if (!space) {
		nerve.sense.publish(err(motor, `enclosure: unknown spaceId: ${motor.payload.spaceId}`));
		return;
	}
	const name = String(motor.payload.name ?? "");
	if (!name) {
		nerve.sense.publish(err(motor, "enclosure.snapshot: name is required"));
		return;
	}
	try {
		await space.snapshot(name);
		nerve.sense.publish(sense(motor, { ok: true, name }));
	} catch (e) {
		nerve.sense.publish(err(motor, `enclosure.snapshot: ${e instanceof Error ? e.message : String(e)}`));
	}
}

async function handleRestore(motor: MotorEvent, nerve: CorpusNerve, spaces: Map<string, Space>): Promise<void> {
	const space = getSpace(motor.payload.spaceId, spaces);
	if (!space) {
		nerve.sense.publish(err(motor, `enclosure: unknown spaceId: ${motor.payload.spaceId}`));
		return;
	}
	const name = String(motor.payload.name ?? "");
	if (!name) {
		nerve.sense.publish(err(motor, "enclosure.restore: name is required"));
		return;
	}
	try {
		await space.restore(name);
		nerve.sense.publish(sense(motor, { ok: true, name }));
	} catch (e) {
		nerve.sense.publish(err(motor, `enclosure.restore: ${e instanceof Error ? e.message : String(e)}`));
	}
}

async function handleExec(motor: MotorEvent, nerve: CorpusNerve, spaces: Map<string, Space>): Promise<void> {
	const space = getSpace(motor.payload.spaceId, spaces);
	if (!space) {
		nerve.sense.publish(err(motor, `enclosure: unknown spaceId: ${motor.payload.spaceId}`));
		return;
	}
	const command = Array.isArray(motor.payload.command) ? (motor.payload.command as string[]) : [];
	if (!command.length) {
		nerve.sense.publish(err(motor, "enclosure.exec: command is required"));
		return;
	}
	const opts: ExecOptions = {
		confine: Boolean(motor.payload.confine ?? false),
		timeoutMs: typeof motor.payload.timeoutMs === "number" ? motor.payload.timeoutMs : undefined,
		memoryMaxBytes: typeof motor.payload.memoryMaxBytes === "number" ? motor.payload.memoryMaxBytes : undefined,
		cpuQuotaUs: typeof motor.payload.cpuQuotaUs === "number" ? motor.payload.cpuQuotaUs : undefined,
	};
	try {
		const result = await space.exec(command, opts);
		const isError = result.exitCode !== 0;
		nerve.sense.publish(
			sense(
				motor,
				{ exitCode: result.exitCode, output: result.output },
				isError,
				isError ? `exit code ${result.exitCode}` : undefined,
			),
		);
	} catch (e) {
		nerve.sense.publish(err(motor, `enclosure.exec: ${e instanceof Error ? e.message : String(e)}`));
	}
}

async function handleDestroy(motor: MotorEvent, nerve: CorpusNerve, spaces: Map<string, Space>): Promise<void> {
	const spaceId = typeof motor.payload.spaceId === "string" ? motor.payload.spaceId : "";
	const space = spaces.get(spaceId);
	if (!space) {
		nerve.sense.publish(err(motor, `enclosure: unknown spaceId: ${spaceId}`));
		return;
	}
	try {
		await space.destroy();
		spaces.delete(spaceId);
		nerve.sense.publish(sense(motor, { ok: true }));
	} catch (e) {
		nerve.sense.publish(err(motor, `enclosure.destroy: ${e instanceof Error ? e.message : String(e)}`));
	}
}
