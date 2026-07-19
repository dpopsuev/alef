import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { blueprintRegistry } from "@dpopsuev/alef-blueprint/registry";
import { defineManagedService, type FoundryServiceHost } from "@dpopsuev/alef-foundry";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { RemoteStrategy } from "@dpopsuev/alef-engine/remote";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ManagedService } from "@dpopsuev/alef-supervisor/lifecycle";
import type { ChildEntry } from "./child-process.js";
import { healthCheck, resolvePath, spawnChild } from "./child-process.js";
import { DEFAULT_ASK_MAX_MS, DEFAULT_ASK_STALL_MS, MIN_REMAINING_MS, SIGKILL_GRACE_MS } from "./constants.js";

/**
 *
 */
export interface ChildAgentService extends ManagedService {
	readonly entry: ChildEntry;
}

let childSeq = 0;

/**
 *
 */
function getChild(deps: ChildLifecycleDeps, name: string): ChildEntry | undefined {
	const svc = deps.runtime.get(name);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by "entry" in svc guard
	if (svc && "entry" in svc) return (svc as ChildAgentService).entry;
	return undefined;
}

/**
 *
 */
function listChildren(deps: ChildLifecycleDeps): ChildEntry[] {
	return deps.runtime
		.names()
		.filter((n) => n.startsWith("child-"))
		.map((n) => getChild(deps, n))
		.filter((e): e is ChildEntry => e !== undefined);
}

/**
 *
 */
export interface ChildLifecycleDeps {
	cwd: string;
	replyEvent: string;
	readinessTimeoutMs: number;
	currentDepth: number;
	maxDepth: number;
	writableRoots?: readonly string[];
	runtime: FoundryServiceHost;
	strategies: Map<string, unknown>;
	publishInnerSignal?: (type: string, payload: Record<string, unknown>, correlationId: string) => void;
	allowedBlueprints?: readonly string[];
	parentAdapterNames?: ReadonlySet<string>;
	logger?: { warn: (fields: Record<string, unknown>, message: string) => void; info?: (fields: Record<string, unknown>, message: string) => void };
}

/**
 *
 */
export async function handleSpawn(
	deps: ChildLifecycleDeps,
	ctx: {
		payload: {
			blueprintPath?: string;
			adapters?: string[];
			cwd?: string;
			sessionId?: string;
			sandbox?: boolean;
		};
		correlationId?: string;
	},
): Promise<Record<string, unknown>> {
	if (deps.currentDepth >= deps.maxDepth) {
		throw new Error(
			`agent.spawn: depth limit reached (current: ${deps.currentDepth}, max: ${deps.maxDepth}). ` +
				`Use agent.run for in-process delegation instead.`,
		);
	}

	const blueprintPath = ctx.payload.blueprintPath;
	if (blueprintPath && deps.allowedBlueprints && !deps.allowedBlueprints.includes(blueprintPath)) {
		throw new Error(`agent.spawn: blueprint '${blueprintPath}' not in allowed list`);
	}

	const requestedAdapters = ctx.payload.adapters;
	const adapters =
		requestedAdapters && deps.parentAdapterNames
			? requestedAdapters.filter((n) => deps.parentAdapterNames!.has(n))
			: requestedAdapters;

	const result = await spawnChild({
		cwd: deps.cwd,
		blueprintPath,
		adapters,
		childCwd: ctx.payload.cwd,
		sessionId: ctx.payload.sessionId,
		sandbox: ctx.payload.sandbox,
		readinessTimeoutMs: deps.readinessTimeoutMs,
		writableRoots: deps.writableRoots,
		childDepth: deps.currentDepth + 1,
	});

	const name = `child-${++childSeq}`;
	const entry: ChildEntry = {
		name,
		endpoint: result.endpoint,
		sessionId: result.sessionId,
		pid: result.child.pid ?? 0,
		process: result.child,
		startedAt: Date.now(),
		tmpDir: result.tmpDir,
	};
	const descriptor = defineManagedService<{ entry: ChildEntry }>({
		name,
		restart: "temporary",
		shareable: false,
		create: () =>
			Promise.resolve({
				entry,
				async stop() {
					entry.process.kill("SIGTERM");
					if (entry.tmpDir) {
						const { rmSync } = await import("node:fs");
						rmSync(entry.tmpDir, { recursive: true, force: true });
					}
				},
				health: () => healthCheck(entry.endpoint),
			}),
	});
	await deps.runtime.ensure(descriptor, { cwd: deps.cwd });

	const strategy = new RemoteStrategy({ endpoint: result.endpoint, replyEvent: deps.replyEvent });
	deps.strategies.set(name, strategy);

	return withDisplay(
		{ name, endpoint: result.endpoint, sessionId: result.sessionId ?? "", pid: entry.pid },
		{ text: `Spawned **${name}** (pid ${entry.pid}) at ${result.endpoint}`, mimeType: "text/markdown" },
	);
}

/**
 *
 */
export async function handleAsk(
	deps: ChildLifecycleDeps,
	ctx: {
		payload: { name: string; prompt: string; stallMs?: number; maxMs?: number };
		toolCallId?: string;
		correlationId: string;
	},
): Promise<Record<string, unknown>> {
	const { name: childName, prompt, stallMs = DEFAULT_ASK_STALL_MS, maxMs = DEFAULT_ASK_MAX_MS } = ctx.payload;
	const parentCallId = ctx.toolCallId ?? ctx.correlationId;
	const entry = getChild(deps, childName);
	if (!entry) throw new Error(`agent.ask: no child named '${childName}'`);

	const strategy = new RemoteStrategy({
		endpoint: entry.endpoint,
		replyEvent: deps.replyEvent,
		stallMs,
		onStall: () => {
			deps.publishInnerSignal?.(
				"agent.child.stalled",
				{ name: childName, callId: parentCallId },
				ctx.correlationId,
			);
			deps.logger?.warn({ child: childName }, "Child stalled — stopping");
			entry.process.kill("SIGTERM");
			void deps.runtime.stopService(childName);
			deps.strategies.delete(childName);
		},
	});
	const reply = await strategy.send({
		text: prompt,
		sender: "human",
		timeoutMs: maxMs,
		onInnerEvent: deps.publishInnerSignal
			? (_callId: string, innerType: string, innerPayload: Record<string, unknown>) =>
					deps.publishInnerSignal?.(innerType, { ...innerPayload, callId: parentCallId }, ctx.correlationId)
			: undefined,
	});
	if (!reply) {
		return withDisplay(
			{ name: childName, reply: null, timedOut: true },
			{ text: `**${childName}** did not reply`, mimeType: "text/markdown" },
		);
	}
	return withDisplay({ name: childName, reply }, { text: reply, mimeType: "text/plain" });
}

/**
 *
 */
export async function handleRace(
	deps: ChildLifecycleDeps,
	ctx: {
		payload: { tasks: Array<{ name: string; prompt: string }>; stallMs?: number; maxMs?: number };
		toolCallId?: string;
		correlationId: string;
	},
): Promise<Record<string, unknown>> {
	const { tasks, stallMs = DEFAULT_ASK_STALL_MS, maxMs = DEFAULT_ASK_MAX_MS } = ctx.payload;
	const parentCallId = ctx.toolCallId ?? ctx.correlationId;
	const results = await Promise.allSettled(
		tasks.map(async ({ name: childName, prompt }) => {
			const entry = getChild(deps, childName);
			if (!entry) return { name: childName, reply: null, error: `no child named '${childName}'` };
			const strategy = new RemoteStrategy({ endpoint: entry.endpoint, replyEvent: deps.replyEvent, stallMs });
			try {
				const reply = await strategy.send({
					text: prompt,
					sender: "human",
					timeoutMs: maxMs,
					onInnerEvent: deps.publishInnerSignal
						? (_callId: string, innerType: string, innerPayload: Record<string, unknown>) =>
								deps.publishInnerSignal?.(
									innerType,
									{ ...innerPayload, callId: parentCallId },
									ctx.correlationId,
								)
						: undefined,
				});
				return { name: childName, reply: reply || null, error: null };
			} catch (err) {
				return { name: childName, reply: null, error: String(err) };
			}
		}),
	);
	const resolved = results.map((r, i) => {
		if (r.status === "fulfilled") return r.value;
		return { name: tasks[i]?.name ?? "unknown", reply: null, error: String(r.reason) };
	});
	const summary = resolved
		.map((r) => `- **${r.name}**: ${r.reply ? `replied (${String(r.reply).length} chars)` : (r.error ?? "no reply")}`)
		.join("\n");
	return withDisplay(
		{ results: resolved, succeeded: resolved.filter((r) => r.reply !== null).length, total: tasks.length },
		{ text: summary, mimeType: "text/markdown" },
	);
}

/**
 *
 */
export async function handleConverse(
	deps: ChildLifecycleDeps,
	ctx: {
		payload: { name: string; prompts: string[]; stallMs?: number; maxMs?: number };
		toolCallId?: string;
		correlationId: string;
	},
): Promise<Record<string, unknown>> {
	const { name: childName, prompts, stallMs = DEFAULT_ASK_STALL_MS, maxMs = DEFAULT_ASK_MAX_MS } = ctx.payload;
	const parentCallId = ctx.toolCallId ?? ctx.correlationId;
	const entry = getChild(deps, childName);
	if (!entry) throw new Error(`agent.converse: no child named '${childName}'`);

	const transcript: Array<{ role: "parent" | "child"; text: string }> = [];
	const conversationStart = Date.now();

	for (const prompt of prompts) {
		if (Date.now() - conversationStart > maxMs) {
			transcript.push({ role: "parent", text: "[conversation timed out]" });
			break;
		}

		transcript.push({ role: "parent", text: prompt });

		const remainingMs = Math.max(MIN_REMAINING_MS, maxMs - (Date.now() - conversationStart));
		const strategy = new RemoteStrategy({
			endpoint: entry.endpoint,
			replyEvent: deps.replyEvent,
			stallMs,
			onStall: () => {
				transcript.push({ role: "child", text: "[stalled — no activity]" });
			},
		});

		try {
			const reply = await strategy.send({
				text: prompt,
				sender: "human",
				timeoutMs: remainingMs,
				onInnerEvent: deps.publishInnerSignal
					? (_callId: string, innerType: string, innerPayload: Record<string, unknown>) =>
							deps.publishInnerSignal?.(innerType, { ...innerPayload, callId: parentCallId }, ctx.correlationId)
					: undefined,
			});
			transcript.push({ role: "child", text: reply || "(no reply)" });
		} catch (err) {
			transcript.push({ role: "child", text: `[error: ${String(err)}]` });
			break;
		}
	}

	const summary = transcript
		.map((t) => `**${t.role}:** ${t.text.slice(0, 200)}${t.text.length > 200 ? "..." : ""}`)
		.join("\n\n");

	return withDisplay(
		{ name: childName, transcript, turns: transcript.length, elapsedMs: Date.now() - conversationStart },
		{ text: summary, mimeType: "text/markdown" },
	);
}

/**
 *
 */
export async function handleKill(
	deps: ChildLifecycleDeps,
	ctx: { payload: { name: string } },
): Promise<Record<string, unknown>> {
	const { name: childName } = ctx.payload;
	const entry = getChild(deps, childName);
	if (!entry)
		return withDisplay(
			{ stopped: false, reason: `no child named '${childName}'` },
			{ text: `No child named '${childName}'`, mimeType: "text/plain" },
		);
	entry.process.kill("SIGTERM");
	await new Promise<void>((res) => {
		// lint-ignore: RAWTIMER SIGKILL escalation
		const t = setTimeout(() => {
			entry.process.kill("SIGKILL");
			res();
		}, SIGKILL_GRACE_MS);
		entry.process.once("exit", () => {
			clearTimeout(t);
			res();
		});
	});
	void deps.runtime.stopService(childName);
	deps.strategies.delete(childName);
	return withDisplay(
		{ stopped: true, name: childName },
		{ text: `Stopped **${childName}**`, mimeType: "text/markdown" },
	);
}

/**
 *
 */
export async function handleList(deps: ChildLifecycleDeps): Promise<Record<string, unknown>> {
	const items = await Promise.all(
		listChildren(deps).map(async (e) => ({
			name: e.name,
			endpoint: e.endpoint,
			sessionId: e.sessionId ?? null,
			pid: e.pid,
			uptimeMs: Date.now() - e.startedAt,
			alive: await healthCheck(e.endpoint),
		})),
	);
	const summary =
		items.length === 0
			? "No running children."
			: items.map((c) => `- **${c.name}** pid=${c.pid} ${c.alive ? "alive" : "dead"} ${c.endpoint}`).join("\n");
	return withDisplay({ children: items }, { text: summary, mimeType: "text/markdown" });
}

/**
 *
 */
export async function handleStatus(
	deps: ChildLifecycleDeps,
	ctx: { payload: { name: string } },
): Promise<Record<string, unknown>> {
	const { name: childName } = ctx.payload;
	const entry = getChild(deps, childName);
	if (!entry)
		return withDisplay(
			{ alive: false, reason: `no child named '${childName}'` },
			{ text: `No child named '${childName}'`, mimeType: "text/plain" },
		);
	const alive = await healthCheck(entry.endpoint);
	const uptimeMs = Date.now() - entry.startedAt;
	return withDisplay(
		{ name: childName, alive, endpoint: entry.endpoint, sessionId: entry.sessionId ?? null, uptimeMs },
		{
			text: `**${childName}** ${alive ? "alive" : "dead"} — uptime ${Math.round(uptimeMs / 1000)}s`,
			mimeType: "text/markdown",
		},
	);
}

/**
 *
 */
export async function handlePromote(
	deps: ChildLifecycleDeps,
	ctx: { payload: { adapterPath: string; blueprintPath?: string } },
): Promise<Record<string, unknown>> {
	const adapterPath = resolvePath(ctx.payload.adapterPath, deps.cwd);
	let blueprintPath: string;
	if (ctx.payload.blueprintPath) {
		const registeredNames = blueprintRegistry.list();
		blueprintPath = registeredNames.includes(ctx.payload.blueprintPath)
			? ctx.payload.blueprintPath
			: resolvePath(ctx.payload.blueprintPath, deps.cwd);
	} else {
		blueprintPath = process.env.ALEF_BLUEPRINT_PATH ?? join(homedir(), ".config", "alef", "agent.yaml");
	}
	let doc: Record<string, unknown> = {};
	try {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- YAML parse returns unknown, cast to expected blueprint shape
		doc = parseYaml(readFileSync(blueprintPath, "utf-8")) as Record<string, unknown>;
	} catch {
		/* start fresh */
	}
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spec is an untyped YAML section
	const spec = (doc.spec ?? {}) as Record<string, unknown>;
	const adapters = Array.isArray(spec.adapters) ? [...(spec.adapters as unknown[])] : [];
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- adapter entries are untyped YAML objects
	if (!adapters.some((o) => (o as { path?: string }).path === adapterPath)) adapters.push({ path: adapterPath });
	spec.adapters = adapters;
	doc.spec = spec;
	writeFileSync(blueprintPath, stringifyYaml(doc), "utf-8");
	
	// Check for warm reboot capability via globalThis (set by RebootPort)
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
	const canWarmReboot = typeof (globalThis as any).alefReboot === "function";
	if (canWarmReboot) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
			await (globalThis as any).alefReboot();
			return withDisplay(
				{ promoted: true, adapterPath, blueprintPath },
				{ text: `Promoted ${adapterPath} — warm reboot complete`, mimeType: "text/plain" },
			);
		} catch (err) {
			return withDisplay(
				{ promoted: false, reason: String(err), adapterPath, blueprintPath },
				{ text: `Wrote ${adapterPath} to blueprint but reboot failed: ${String(err)}`, mimeType: "text/plain" },
			);
		}
	}
	
	return withDisplay(
		{ promoted: false, reason: "warm reboot not available", adapterPath, blueprintPath },
		{
			text: `Wrote ${adapterPath} to blueprint but warm reboot not available — restart to apply`,
			mimeType: "text/plain",
		},
	);
}
