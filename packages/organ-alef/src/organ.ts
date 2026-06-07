/**
 * AlefApiOrgan — typed tools for querying the running Alef instance.
 *
 * Replaces the nodesh prelude used in :meta phase 1.
 * The organ is loaded by the in-process meta-agent only — it is never
 * part of the main agent's organ set.
 *
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { ActionMap, Organ, SkillBook, ToolDefinition } from "@dpopsuev/alef-kernel";
import { defineOrgan, passthroughSchema, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { scanSessionFiles } from "@dpopsuev/alef-session";
import { z } from "zod";

export interface DirectiveAdapter {
	list(): ReadonlyArray<{ id: string; priority: number; enabled: boolean; tags?: string[]; contentPreview: string }>;
	enable(id: string): void;
	disable(id: string): void;
	toggle(id: string): void;
	replace(id: string, content: string): void;
	add(id: string, priority: number, content: string, tags?: string[]): void;
	remove(id: string): void;
}

export interface AgentPrototypeAdapter {
	load(organ: Organ): void;
	unload(name: string): boolean;
	readonly organs: readonly Organ[];
}

export interface AlefApiOrganOptions {
	getDirective?: () => DirectiveAdapter | undefined;
	/** Agent adapter for prototype.plug/unplug/list. Omit to disable prototype tools. */
	agent?: AgentPrototypeAdapter;
	/** Load an organ from a TypeScript file path. Injected by local-session. */
	loadOrgan?: (path: string, cwd: string) => Promise<Organ>;
	/** Working directory for relative path resolution in prototype.plug. */
	cwd?: string;
	/** Called when alef.rebuild is triggered. Injected by local-session via supervisor. */
	onRebuildRequest?: () => void;
}

const CONFIG_ROOT = join(homedir(), ".config", "alef");

interface SessionEntry {
	id: string;
	cwdHash: string;
	mtime: string;
	name: string | undefined;
	firstMessage: string;
	contentFingerprint: string;
	eventCount: number;
}

async function parseSession(
	path: string,
): Promise<{ name: string | undefined; firstMessage: string; contentFingerprint: string; eventCount: number }> {
	try {
		const raw = await readFile(path, "utf-8");
		const lines = raw.split("\n").filter(Boolean);
		let name: string | undefined;
		let firstMessage = "";
		const contentParts: string[] = [];
		for (const line of lines) {
			try {
				const r = JSON.parse(line) as { bus?: string; type?: string; payload?: { text?: string; name?: string } };
				if (r.bus === "internal" && r.type === "session.name" && typeof r.payload?.name === "string") {
					name = r.payload.name;
				}
				if (r.bus === "sense" && r.type === "dialog.message") {
					const text = (r.payload?.text ?? "").replace(/\n/g, " ");
					if (!firstMessage) firstMessage = text.slice(0, 80);
					if (contentParts.length < 20) contentParts.push(text.slice(0, 200));
				}
			} catch {
				break;
			}
		}
		return { name, firstMessage, contentFingerprint: contentParts.join(" "), eventCount: lines.length };
	} catch {
		return { name: undefined, firstMessage: "", contentFingerprint: "", eventCount: 0 };
	}
}

async function listAllSessions(): Promise<SessionEntry[]> {
	const results: SessionEntry[] = [];
	await scanSessionFiles(async (id, path, cwdHash) => {
		const s = await stat(path);
		const parsed = await parseSession(path);
		results.push({ id, cwdHash, mtime: s.mtime.toISOString(), ...parsed });
	});
	return results.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

async function readSessionTurns(id: string, maxTurns = 10): Promise<{ turn: string; type: string }[]> {
	let found: { turn: string; type: string }[] = [];
	await scanSessionFiles(async (sessionId, path) => {
		if (sessionId !== id || found.length > 0) return;
		const raw = await readFile(path, "utf-8");
		const turns: { turn: string; type: string }[] = [];
		for (const line of raw.split("\n").filter(Boolean)) {
			try {
				const r = JSON.parse(line) as { type?: string; payload?: { text?: string } };
				if (r.type === "dialog.message") {
					const text = r.payload?.text ?? "";
					if (text) turns.push({ turn: text.slice(0, 200), type: "message" });
					if (turns.length >= maxTurns) break;
				}
			} catch {
				break;
			}
		}
		found = turns;
	});
	return found;
}

async function renameSession(id: string, name: string): Promise<{ ok: boolean; error?: string }> {
	let renamed = false;
	await scanSessionFiles(async (sessionId, path) => {
		if (sessionId !== id || renamed) return;
		const record = JSON.stringify({
			bus: "internal",
			type: "session.name",
			correlationId: "meta",
			payload: { name },
			timestamp: Date.now(),
		});
		const { appendFile } = await import("node:fs/promises");
		await appendFile(path, `${record}\n`, "utf-8");
		renamed = true;
	});
	return renamed ? { ok: true } : { ok: false, error: `Session '${id}' not found` };
}

async function searchSessions(
	query: string,
): Promise<Array<{ id: string; mtime: string; name: string | undefined; snippet: string }>> {
	const all = await listAllSessions();
	const lower = query.toLowerCase();
	return all
		.filter((s) => {
			const haystack = `${s.name ?? ""} ${s.firstMessage} ${s.contentFingerprint}`.toLowerCase();
			return haystack.includes(lower);
		})
		.map((s) => ({
			id: s.id,
			mtime: s.mtime,
			name: s.name,
			snippet: s.name ? `${s.name} — ${s.firstMessage}` : s.firstMessage,
		}));
}

async function getConfig(): Promise<Record<string, unknown>> {
	try {
		const path = join(CONFIG_ROOT, "config.yaml");
		const raw = await readFile(path, "utf-8");
		return { raw };
	} catch {
		return { raw: "(no config file)" };
	}
}

async function listOrgans(): Promise<string[]> {
	try {
		const path = join(CONFIG_ROOT, "organs.yaml");
		const raw = await readFile(path, "utf-8");
		return [raw];
	} catch {
		return ["(organs.yaml not found)"];
	}
}

async function pmHistory(): Promise<Array<{ id: number; ts: string; organs: Record<string, string> }>> {
	try {
		const genDir = join(CONFIG_ROOT, "generations");
		const files = await readdir(genDir);
		const entries = await Promise.all(
			files
				.filter((f) => f.endsWith(".json"))
				.map(async (f) => {
					const raw = await readFile(join(genDir, f), "utf-8");
					const gen = JSON.parse(raw) as { id: number; ts: string; lockfileContent: string };
					const organs: Record<string, string> = {};
					try {
						const lock = JSON.parse(gen.lockfileContent) as { packages?: Record<string, { version?: string }> };
						for (const [k, v] of Object.entries(lock.packages ?? {})) {
							if (k.startsWith("node_modules/")) organs[k.slice("node_modules/".length)] = v.version ?? "?";
						}
					} catch {
						/* no lockfile */
					}
					return { id: gen.id, ts: gen.ts, organs };
				}),
		);
		return entries.sort((a, b) => b.id - a.id);
	} catch {
		return [];
	}
}

const PROTOTYPES_DIR = join(homedir(), ".alef", "prototypes");
const WORKER_BOOTSTRAP = fileURLToPath(new URL("./prototype-worker.ts", import.meta.url));

function loadOrganInWorker(organPath: string, cwd: string): Promise<Organ> {
	return new Promise((resolveP, rejectP) => {
		const worker = new Worker(WORKER_BOOTSTRAP, {
			execArgv: process.execArgv,
			workerData: { organPath, cwd },
		});

		// lint-ignore: RAWTIMER one-shot readiness deadline for worker bootstrap
		const timer = setTimeout(() => {
			void worker.terminate();
			rejectP(new Error(`Worker organ '${organPath}' did not send ready within 15s`));
		}, 15_000);

		worker.once(
			"message",
			(msg: {
				type: string;
				name: string;
				tools: Array<{ name: string; description: string; jsonSchema: Record<string, unknown> }>;
				subscriptions: { motor: string[]; sense: string[] };
			}) => {
				if (msg.type !== "ready") {
					clearTimeout(timer);
					void worker.terminate();
					rejectP(new Error(`Worker sent unexpected first message: ${msg.type}`));
					return;
				}
				clearTimeout(timer);

				const tools: ToolDefinition[] = msg.tools.map((t) => ({
					name: t.name,
					description: t.description,
					inputSchema: passthroughSchema(t.jsonSchema),
				}));

				const proxyOrgan: Organ = {
					name: msg.name,
					tools,
					subscriptions: { motor: msg.subscriptions.motor, sense: msg.subscriptions.sense },
					mount(nerve) {
						const offs = msg.subscriptions.motor.map((type) =>
							nerve.motor.subscribe(type, (event) => {
								worker.postMessage({ dir: "motor", event });
							}),
						);
						const onMessage = (workerMsg: { dir: string; event: Record<string, unknown> }) => {
							if (workerMsg.dir === "sense") {
								nerve.sense.publish(workerMsg.event as Parameters<typeof nerve.sense.publish>[0]);
							}
						};
						worker.on("message", onMessage);
						return () => {
							for (const off of offs) off();
							worker.off("message", onMessage);
							void worker.terminate();
						};
					},
				};

				resolveP(proxyOrgan);
			},
		);

		worker.once("error", (err) => {
			clearTimeout(timer);
			rejectP(new Error(`Worker organ error: ${err.message}`));
		});
		worker.once("exit", (code) => {
			clearTimeout(timer);
			if (code !== 0) rejectP(new Error(`Worker organ exited with code ${code}`));
		});
	});
}

const PROTOTYPING_BOOK: SkillBook = {
	name: "prototyping",
	description: "Synthesizing and plugging new organs at runtime when a capability is missing.",
	pages: [
		{
			name: "capability-gap",
			description: "When to synthesize a new organ instead of improvising.",
			instructions: `Synthesize a new organ when:
- You need a capability that none of your current tools provide.
- You have tried and failed with existing tools (not just anticipated failure).
- The capability is reusable across multiple steps in the current task.

Do NOT synthesize when a shell command, nodesh.eval, or web.fetch would suffice.
Always check tools.describe([]) first — the tool you need may already exist.`,
		},
		{
			name: "scaffold",
			description: "The canonical organ template. Use this exactly — do not guess the API.",
			instructions: `Every organ file must follow this exact structure:

\`\`\`typescript
import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";

export function createOrgan() {
  const TOOL = {
    name: "namespace.action",
    description: "One sentence: what this tool does.",
    inputSchema: z.object({
      param: z.string().min(1).describe("What this parameter is for"),
    }),
  };

  return defineOrgan("namespace", {
    "motor/namespace.action": typedAction(TOOL, async (ctx) => {
      const { param } = ctx.payload;
      // implementation
      return withDisplay(
        { result: param },
        { text: \`Done: \${param}\`, mimeType: "text/plain" },
      );
    }),
  }, {
    description: "One sentence describing the organ.",
    directives: ["Guidance for the LLM on when and how to use this organ."],
  });
}
\`\`\`

Rules:
- Import only from @dpopsuev/alef-kernel and zod.
- The motor key must be "motor/<name>.<action>".
- Always return withDisplay(...) from handlers.
- Export only createOrgan — no default export.`,
		},
		{
			name: "iterate-loop",
			description: "The write → plug → test → patch cycle for iterating on a prototype.",
			instructions: `To prototype and iterate on a new organ:

1. Call factory.organ to write a validated scaffold to disk.
2. Call prototype.plug({ path }) to load it into the running agent.
3. Call the new tool to verify it works.
4. If it fails or needs changes:
   a. Edit the file with fs.edit.
   b. Call prototype.unplug({ name }) to remove the old instance.
   c. Call prototype.plug({ path }) to reload the updated version.
   d. Repeat from step 3.
5. When satisfied, the organ is live. It will not persist across restarts
   unless added to the blueprint.

Maximum 5 iterations before stopping and reporting what is not working.`,
		},
	],
};

function buildPrototypeTools(
	agent: AgentPrototypeAdapter,
	loadOrgan: NonNullable<AlefApiOrganOptions["loadOrgan"]>,
	cwd: string,
): ActionMap {
	return {
		"motor/prototype.plug": typedAction(
			{
				name: "prototype.plug",
				description:
					"Load a TypeScript organ into the running agent. " +
					"Pass path to an existing .ts file, or code to write one to ~/.alef/prototypes/ first. " +
					"The organ's tools become available immediately.",
				inputSchema: z
					.object({
						path: z
							.string()
							.optional()
							.describe("Absolute or cwd-relative path to a .ts file exporting createOrgan()"),
						code: z
							.string()
							.optional()
							.describe("TypeScript organ source. Written to ~/.alef/prototypes/<name>.ts."),
						name: z
							.string()
							.optional()
							.describe("File name (without .ts) when using code. Defaults to 'prototype'."),
					})
					.refine((d) => d.path ?? d.code, "Provide either path or code")
					.and(
						z.object({
							thread: z
								.boolean()
								.optional()
								.describe(
									"Run the organ in a worker_threads.Worker for crash isolation. " +
										"The organ cannot call process.exit() on the main thread and can be terminate()d safely.",
								),
						}),
					),
			},
			async (ctx) => {
				let organPath: string;
				if (ctx.payload.code) {
					await mkdir(PROTOTYPES_DIR, { recursive: true });
					const filename = `${ctx.payload.name ?? "prototype"}.ts`;
					organPath = join(PROTOTYPES_DIR, filename);
					await writeFile(organPath, ctx.payload.code, "utf-8");
				} else {
					organPath = resolve(cwd, ctx.payload.path as string);
				}
				const useThread = (ctx.payload as { thread?: boolean }).thread ?? false;
				const organ = useThread ? await loadOrganInWorker(organPath, cwd) : await loadOrgan(organPath, cwd);
				agent.load(organ);
				const toolNames = organ.tools.map((t) => t.name);
				return withDisplay(
					{ name: organ.name, tools: toolNames, path: organPath },
					{
						text: `Plugged organ '${organ.name}' — tools: ${toolNames.join(", ") || "(none)"}`,
						mimeType: "text/plain",
					},
				);
			},
		),
		"motor/prototype.unplug": typedAction(
			{
				name: "prototype.unplug",
				description: "Unload a prototype organ from the running agent by name.",
				inputSchema: z.object({
					name: z.string().min(1).describe("Organ name as returned by prototype.list"),
				}),
			},
			async (ctx) => {
				const removed = agent.unload(ctx.payload.name);
				return withDisplay(
					{ unloaded: removed, name: ctx.payload.name },
					{
						text: removed ? `Unplugged '${ctx.payload.name}'` : `Organ '${ctx.payload.name}' not found`,
						mimeType: "text/plain",
					},
				);
			},
		),
		"motor/prototype.list": typedAction(
			{
				name: "prototype.list",
				description: "List all organs currently loaded in the running agent.",
				inputSchema: z.object({}),
			},
			() => {
				const organs = agent.organs.map((o) => ({ name: o.name, tools: o.tools.map((t) => t.name) }));
				return Promise.resolve(
					withDisplay({ organs }, { text: `${organs.length} organ(s) loaded`, mimeType: "text/plain" }),
				);
			},
		),
	};
}

function buildDirectiveTools(g: NonNullable<AlefApiOrganOptions["getDirective"]>): ActionMap {
	return {
		"motor/alef.directive.list": typedAction(
			{
				name: "alef.directive.list",
				description: "List all system prompt blocks with id, priority, enabled state, tags, and content preview.",
				inputSchema: z.object({}),
			},
			async () => {
				const blocks = g()?.list() ?? [];
				return withDisplay({ blocks }, { text: `${blocks.length} directive block(s)`, mimeType: "text/plain" });
			},
		),
		"motor/alef.directive.enable": typedAction(
			{
				name: "alef.directive.enable",
				description: "Enable a system prompt block.",
				inputSchema: z.object({ id: z.string().min(1) }),
			},
			async (ctx) => {
				g()?.enable(ctx.payload.id);
				return withDisplay({ ok: true }, { text: `Enabled directive: ${ctx.payload.id}`, mimeType: "text/plain" });
			},
		),
		"motor/alef.directive.disable": typedAction(
			{
				name: "alef.directive.disable",
				description: "Disable a system prompt block.",
				inputSchema: z.object({ id: z.string().min(1) }),
			},
			async (ctx) => {
				g()?.disable(ctx.payload.id);
				return withDisplay({ ok: true }, { text: `Disabled directive: ${ctx.payload.id}`, mimeType: "text/plain" });
			},
		),
		"motor/alef.directive.toggle": typedAction(
			{
				name: "alef.directive.toggle",
				description: "Toggle a system prompt block on or off.",
				inputSchema: z.object({ id: z.string().min(1) }),
			},
			async (ctx) => {
				g()?.toggle(ctx.payload.id);
				return withDisplay({ ok: true }, { text: `Toggled directive: ${ctx.payload.id}`, mimeType: "text/plain" });
			},
		),
		"motor/alef.directive.replace": typedAction(
			{
				name: "alef.directive.replace",
				description: "Replace the content of a system prompt block.",
				inputSchema: z.object({ id: z.string().min(1), content: z.string().min(1) }),
			},
			async (ctx) => {
				g()?.replace(ctx.payload.id, ctx.payload.content);
				return withDisplay({ ok: true }, { text: `Replaced directive: ${ctx.payload.id}`, mimeType: "text/plain" });
			},
		),
		"motor/alef.directive.add": typedAction(
			{
				name: "alef.directive.add",
				description: "Add a new block to the system prompt.",
				inputSchema: z.object({
					id: z.string().min(1),
					priority: z.number(),
					content: z.string().min(1),
					tags: z.array(z.string()).optional(),
				}),
			},
			async (ctx) => {
				g()?.add(ctx.payload.id, ctx.payload.priority, ctx.payload.content, ctx.payload.tags);
				return withDisplay(
					{ ok: true },
					{
						text: `Added directive: ${ctx.payload.id} (priority ${ctx.payload.priority})`,
						mimeType: "text/plain",
					},
				);
			},
		),
		"motor/alef.directive.remove": typedAction(
			{
				name: "alef.directive.remove",
				description: "Remove a block from the prompt scroll.",
				inputSchema: z.object({ id: z.string().min(1) }),
			},
			async (ctx) => {
				g()?.remove(ctx.payload.id);
				return withDisplay({ ok: true }, { text: `Removed directive: ${ctx.payload.id}`, mimeType: "text/plain" });
			},
		),
	};
}

function buildSessionTools(opts: AlefApiOrganOptions): ActionMap {
	return {
		"motor/alef.sessions.list": typedAction(
			{
				name: "alef.sessions.list",
				description: "List all Alef sessions across all working directories, newest first.",
				inputSchema: z.object({}),
			},
			async () => {
				const sessions = await listAllSessions();
				return withDisplay({ sessions }, { text: `${sessions.length} session(s)`, mimeType: "text/plain" });
			},
			{ shouldCache: () => false },
		),
		"motor/alef.sessions.search": typedAction(
			{
				name: "alef.sessions.search",
				description: "Search sessions by keyword across name, first message, and conversation content.",
				inputSchema: z.object({ query: z.string().min(1).describe("Keyword or phrase to search for") }),
			},
			async (ctx) => {
				const results = await searchSessions(ctx.payload.query);
				return withDisplay(
					{ results },
					{ text: `${results.length} session(s) matching "${ctx.payload.query}"`, mimeType: "text/plain" },
				);
			},
		),
		"motor/alef.sessions.rename": typedAction(
			{
				name: "alef.sessions.rename",
				description: "Give a session a human-readable name so it can be found later.",
				inputSchema: z.object({
					id: z.string().min(1).describe("8-char session ID"),
					name: z.string().min(1).describe("Concise descriptive name, e.g. 'ToolShell eval and amnesia fix'"),
				}),
			},
			async (ctx) => {
				const result = await renameSession(ctx.payload.id, ctx.payload.name);
				return withDisplay(result, {
					text: result.ok
						? `Renamed session ${ctx.payload.id} to "${ctx.payload.name}"`
						: `Rename failed: ${result.error}`,
					mimeType: "text/plain",
				});
			},
		),
		"motor/alef.sessions.read": typedAction(
			{
				name: "alef.sessions.read",
				description: "Read the first N turns of a session by ID.",
				inputSchema: z.object({
					id: z.string().min(1).describe("8-char session ID"),
					maxTurns: z.number().optional().default(10).describe("Max turns to return (default 10)"),
				}),
			},
			async (ctx) => {
				const turns = await readSessionTurns(ctx.payload.id, ctx.payload.maxTurns);
				return withDisplay(
					{ turns },
					{ text: `${turns.length} turn(s) from session ${ctx.payload.id}`, mimeType: "text/plain" },
				);
			},
		),
		"motor/alef.config.get": typedAction(
			{
				name: "alef.config.get",
				description: "Get the current Alef config from ~/.config/alef/config.yaml.",
				inputSchema: z.object({}),
			},
			async () => {
				const config = await getConfig();
				return withDisplay({ config }, { text: "Alef config loaded", mimeType: "text/plain" });
			},
			{ shouldCache: () => true },
		),
		"motor/alef.organs.list": typedAction(
			{
				name: "alef.organs.list",
				description: "List user-installed organs from ~/.config/alef/organs.yaml.",
				inputSchema: z.object({}),
			},
			async () => {
				const organs = await listOrgans();
				return withDisplay({ organs }, { text: "organs.yaml loaded", mimeType: "text/plain" });
			},
			{ shouldCache: () => true },
		),
		"motor/alef.pm.history": typedAction(
			{
				name: "alef.pm.history",
				description: "List organ package manager generation history.",
				inputSchema: z.object({}),
			},
			async () => {
				const history = await pmHistory();
				return withDisplay(
					{ history },
					{ text: `${history.length} generation(s) in PM history`, mimeType: "text/plain" },
				);
			},
			{ shouldCache: () => true },
		),
		"motor/alef.rebuild": typedAction(
			{
				name: "alef.rebuild",
				description:
					"Trigger a blue-green rebuild: runs npm run check, spawns a new green with the same session, " +
					"and promotes it if healthy. Only available when running under the supervisor (alef-dev.sh). " +
					"Use after editing source files to apply the fix without losing session context.",
				inputSchema: z.object({}),
			},
			async (ctx) => {
				if (typeof opts.onRebuildRequest !== "function") {
					ctx.log.warn({}, "alef.rebuild called but supervisor is not running");
					return withDisplay(
						{ ok: false, reason: "supervisor not running — start with alef-dev.sh" },
						{ text: "rebuild: supervisor not running — start with alef-dev.sh", mimeType: "text/plain" },
					);
				}
				opts.onRebuildRequest();
				ctx.log.info({}, "alef.rebuild: rebuild requested");
				return withDisplay(
					{ ok: true, reason: "rebuild requested — new green will take over when healthy" },
					{
						text: "rebuild: triggered — new green spawning, session will continue on promotion",
						mimeType: "text/plain",
					},
				);
			},
		),
	};
}

export function createAlefApiOrgan(opts: AlefApiOrganOptions = {}) {
	const { agent, loadOrgan, cwd = process.cwd(), getDirective } = opts;
	return defineOrgan(
		"alef",
		{
			...(getDirective ? buildDirectiveTools(getDirective) : {}),
			...(agent && loadOrgan ? buildPrototypeTools(agent, loadOrgan, cwd) : {}),
			...buildSessionTools(opts),
		},
		{
			description:
				"Query Alef sessions, config, organs, package manager history, manage the system prompt, and prototype new organs.",
			skills: [PROTOTYPING_BOOK],
			directives: [
				"Use alef.sessions.list to discover all sessions. Use alef.sessions.search to find sessions by topic — it searches name, first message, and content. " +
					"Use alef.sessions.read to get the content of a specific session. " +
					"Use alef.sessions.rename to give a session a memorable name when asked. " +
					"Use alef.config.get, alef.organs.list, alef.pm.history for system information. " +
					"Use alef.directive.list to show the active prompt blocks. Use alef.directive.enable/disable/toggle to change which blocks are active. " +
					"Use alef.directive.replace to change block content. Use alef.directive.add to inject a new block. " +
					"Use alef.rebuild to apply source edits via a zero-downtime blue-green swap (requires alef-dev.sh). " +
					"Use prototype.plug to load a new organ at runtime (pass path or code). Use prototype.unplug to remove it. Use prototype.list to see what is loaded. " +
					"Respond concisely with the most relevant data. Do not write files.",
			],
			labels: ["alef-api", "meta", "sessions", "scroll"],
		},
	);
}
