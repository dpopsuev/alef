/**
 * MetaAdapter — typed tools for querying the running Alef instance.
 *
 * Replaces the nodesh prelude used in :meta phase 1.
 * The adapter is loaded by the in-process meta-agent only — it is never
 * part of the main agent's adapter set.
 *
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
	type ActionMap,
	type Adapter,
	type CommandHandlerCtx,
	defineAdapter,
	passthroughSchema,
	type SkillBook,
	type ToolDefinition,
	typedAction,
} from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";
import {
	getConfig,
	listAdapters,
	listAllSessions,
	pmHistory,
	readSessionTurns,
	renameSession,
	searchSessions,
} from "./session-queries.js";
import type { DirectiveView } from "@dpopsuev/alef-session/contracts";

/**
 * @deprecated Use DirectiveView from @dpopsuev/alef-session/contracts
 */
export type DirectiveAdapter = DirectiveView;

/**
 *
 */
export interface AgentPrototypeAdapter {
	load(adapter: Adapter): void;
	unload(name: string): boolean;
	readonly adapters: readonly Adapter[];
}

/**
 *
 */
export interface MetaAdapterOptions {
	getDirective?: () => DirectiveView | undefined;
	/** Agent adapter for prototype.plug/unplug/list. Omit to disable prototype tools. */
	agent?: AgentPrototypeAdapter;
	/** Load an adapter from a TypeScript file path. Injected by local-session. */
	loadAdapter?: (path: string, cwd: string) => Promise<Adapter>;
	/** Working directory for relative path resolution in prototype.plug. */
	cwd?: string;
	/** Called when alef.rebuild is triggered. Injected by local-session via supervisor. */
	onRebuildRequest?: () => void;
	/** Event type for dialog messages in session JSONL logs. Provided by assembly. */
	dialogEventType: string;
}

const PROTOTYPES_DIR = join(homedir(), ".alef", "prototypes");
const WORKER_BOOTSTRAP = fileURLToPath(new URL("./prototype-worker.ts", import.meta.url));

/**
 *
 */
function loadAdapterInWorker(adapterPath: string, cwd: string): Promise<Adapter> {
	return new Promise((resolveP, rejectP) => {
		const worker = new Worker(WORKER_BOOTSTRAP, {
			execArgv: process.execArgv,
			workerData: { adapterPath: adapterPath, cwd },
		});

		// lint-ignore: RAWTIMER one-shot readiness deadline for worker bootstrap
		const timer = setTimeout(() => {
			void worker.terminate();
			rejectP(new Error(`Worker adapter '${adapterPath}' did not send ready within 15s`));
		}, 15_000);

		worker.once(
			"message",
			(msg: {
				type: string;
				name: string;
				tools: Array<{ name: string; description: string; jsonSchema: Record<string, unknown> }>;
				subscriptions: { command: string[]; event: string[]; notification: string[] };
				sources: [];
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

				const proxyAdapter: Adapter = {
					name: msg.name,
					tools,
					subscriptions: {
						command: msg.subscriptions.command,
						event: msg.subscriptions.event,
						notification: msg.subscriptions.notification,
					},
					sources: [],
					mount(bus) {
						const offs = msg.subscriptions.command.map((type) =>
							bus.command.subscribe(type, (event) => {
								worker.postMessage({ dir: "command", event });
							}),
						);
						const onMessage = (workerMsg: { dir: string; event: Record<string, unknown> }) => {
							if (workerMsg.dir === "event") {
								// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- worker bridge event shape matches EventInput
								bus.event.publish(workerMsg.event as Parameters<typeof bus.event.publish>[0]);
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

				resolveP(proxyAdapter);
			},
		);

		worker.once("error", (err) => {
			clearTimeout(timer);
			rejectP(new Error(`Worker adapter error: ${err.message}`));
		});
		worker.once("exit", (code) => {
			clearTimeout(timer);
			if (code !== 0) rejectP(new Error(`Worker adapter exited with code ${code}`));
		});
	});
}

const PROTOTYPING_BOOK: SkillBook = {
	name: "prototyping",
	description: "Synthesizing and plugging new adapters at runtime when a capability is missing.",
	pages: [
		{
			name: "capability-gap",
			description: "When to synthesize a new adapter instead of improvising.",
			instructions: `Synthesize a new adapter when:
- You need a capability that none of your current tools provide.
- You have tried and failed with existing tools (not just anticipated failure).
- The capability is reusable across multiple steps in the current task.

Do NOT synthesize when a shell command, nodesh.eval, or web.fetch would suffice.
Always check tools.describe([]) first — the tool you need may already exist.`,
		},
		{
			name: "scaffold",
			description: "The canonical adapter template. Use this exactly — do not guess the API.",
			instructions: `Every adapter file must follow this exact structure:

\`\`\`typescript
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";

export function createAdapter() {
  const TOOL = {
    name: "namespace.action",
    description: "One sentence: what this tool does.",
    inputSchema: z.object({
      param: z.string().min(1).describe("What this parameter is for"),
    }),
  };

  return defineAdapter("namespace", {
    command: {
      "namespace.action": typedAction(TOOL, async (ctx) => {
        const { param } = ctx.payload;
        // implementation
        return withDisplay(
          { result: param },
          { text: \`Done: \${param}\`, mimeType: "text/plain" },
        );
      }),
    },
  }, {
    description: "One sentence describing the adapter.",
    directives: ["Guidance for the LLM on when and how to use this adapter."],
  });
}
\`\`\`

Rules:
- Import only from @dpopsuev/alef-kernel and zod.
- The command key must be "<name>.<action>" under the command: { } block.
- Always return withDisplay(...) from handlers.
- Export only createAdapter — no default export.`,
		},
		{
			name: "iterate-loop",
			description: "The write → plug → test → patch cycle for iterating on a prototype.",
			instructions: `To prototype and iterate on a new adapter:

1. Call factory.adapter to write a validated scaffold to disk.
2. Call prototype.plug({ path }) to load it into the running agent.
3. Call the new tool to verify it works.
4. If it fails or needs changes:
   a. Edit the file with fs.edit.
   b. Call prototype.unplug({ name }) to remove the old instance.
   c. Call prototype.plug({ path }) to reload the updated version.
   d. Repeat from step 3.
5. When satisfied, the adapter is live. It will not persist across restarts
   unless added to the blueprint.

Maximum 5 iterations before stopping and reporting what is not working.`,
		},
	],
};

const CORE_ADAPTERS = new Set([
	"fs",
	"shell",
	"nodesh",
	"code-intel",
	"web",
	"agent",
	"alef",
	"dialog",
	"toolshell",
	"context.assembly",
	"security-policy",
]);

const FORBIDDEN_CODE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
	{ pattern: /process\.exit/, reason: "process.exit would terminate the host agent" },
	{ pattern: /child_process/, reason: "child_process bypasses adapter isolation" },
	{ pattern: /require\s*\(/, reason: "require() is forbidden in ESM — use import" },
	{ pattern: /eval\s*\(/, reason: "eval() executes arbitrary code outside adapter scope" },
	{ pattern: /Function\s*\(/, reason: "Function constructor executes arbitrary code" },
	{
		pattern: /import\s*\(\s*['"`](?!@dpopsuev\/alef)/,
		reason: "dynamic imports outside @dpopsuev/alef bypass dependency control",
	},
];

/**
 *
 */
function validateAdapterCode(code: string): string | null {
	for (const { pattern, reason } of FORBIDDEN_CODE_PATTERNS) {
		if (pattern.test(code)) return reason;
	}
	if (!code.includes("defineAdapter")) return "adapter code must use defineAdapter() from @dpopsuev/alef-kernel";
	return null;
}

const PROTOTYPE_PLUG = {
	name: "prototype.plug",
	description:
		"Load a TypeScript adapter into the running agent. " +
		"Pass path to an existing .ts file, or code to write one to ~/.alef/prototypes/ first. " +
		"The adapter's tools become available immediately.",
	inputSchema: z
		.object({
			path: z
				.string()
				.optional()
				.describe("Absolute or cwd-relative path to a .ts file exporting createAdapter()"),
			code: z
				.string()
				.optional()
				.describe("TypeScript adapter source. Written to ~/.alef/prototypes/<name>.ts."),
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
						"Run the adapter in a worker_threads.Worker for crash isolation. " +
							"The adapter cannot call process.exit() on the main thread and can be terminate()d safely.",
					),
			}),
		),
} as const;

const PROTOTYPE_UNPLUG = {
	name: "prototype.unplug",
	description: "Unload a prototype adapter from the running agent by name.",
	inputSchema: z.object({
		name: z.string().min(1).describe("Adapter name as returned by prototype.list"),
	}),
} as const;

const PROTOTYPE_LIST = {
	name: "prototype.list",
	description: "List all adapters currently loaded in the running agent.",
	inputSchema: z.object({}),
} as const;

/**
 *
 */
function buildPrototypeTools(
	agent: AgentPrototypeAdapter,
	loadAdapter: NonNullable<MetaAdapterOptions["loadAdapter"]>,
	cwd: string,
): ActionMap {
	/**
	 *
	 */
	async function handlePrototypePlug(
		ctx: CommandHandlerCtx<z.infer<typeof PROTOTYPE_PLUG.inputSchema>>,
	): Promise<Record<string, unknown>> {
		let adapterPath: string;
		if (ctx.payload.code) {
			const code = ctx.payload.code;
			const rejection = validateAdapterCode(code);
			if (rejection) {
				return withDisplay(
					{ error: "validation failed", reason: rejection },
					{ text: `Rejected: ${rejection}`, mimeType: "text/plain" },
				);
			}
			await mkdir(PROTOTYPES_DIR, { recursive: true });
			const filename = `${ctx.payload.name ?? "prototype"}.ts`;
			adapterPath = join(PROTOTYPES_DIR, filename);
			await writeFile(adapterPath, code, "utf-8");
		} else {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- zod refine guarantees path is set in this branch
			adapterPath = resolve(cwd, ctx.payload.path as string);
		}
		const useThread = (ctx.payload as { thread?: boolean }).thread ?? false;
		const adapter = useThread
			? await loadAdapterInWorker(adapterPath, cwd)
			: await loadAdapter(adapterPath, cwd);
		agent.load(adapter);
		const toolNames = adapter.tools.map((t) => t.name);
		return withDisplay(
			{ name: adapter.name, tools: toolNames, path: adapterPath },
			{
				text: `Plugged adapter '${adapter.name}' — tools: ${toolNames.join(", ") || "(none)"}`,
				mimeType: "text/plain",
			},
		);
	}

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handlePrototypeUnplug(
		ctx: CommandHandlerCtx<z.infer<typeof PROTOTYPE_UNPLUG.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const { name } = ctx.payload;
		if (CORE_ADAPTERS.has(name)) {
			return withDisplay(
				{ unloaded: false, name, reason: "core adapter" },
				{
					text: `Cannot unplug '${name}' — core adapter required for agent operation`,
					mimeType: "text/plain",
				},
			);
		}
		const removed = agent.unload(name);
		return withDisplay(
			{ unloaded: removed, name },
			{
				text: removed ? `Unplugged '${name}'` : `Adapter '${name}' not found`,
				mimeType: "text/plain",
			},
		);
	}

	/**
	 *
	 */
	function handlePrototypeList(): Promise<Record<string, unknown>> {
		const adapters = agent.adapters.map((o) => ({ name: o.name, tools: o.tools.map((t) => t.name) }));
		return Promise.resolve(
			withDisplay({ adapters }, { text: `${adapters.length} adapter(s) loaded`, mimeType: "text/plain" }),
		);
	}

	return {
		command: {
			"prototype.plug": typedAction(PROTOTYPE_PLUG, handlePrototypePlug),
			"prototype.unplug": typedAction(PROTOTYPE_UNPLUG, handlePrototypeUnplug),
			"prototype.list": typedAction(PROTOTYPE_LIST, handlePrototypeList),
		},
	};
}

const DIRECTIVE_LIST = {
	name: "alef.directive.list",
	description: "List all system prompt blocks with id, priority, enabled state, tags, and content preview.",
	inputSchema: z.object({}),
} as const;

const DIRECTIVE_ENABLE = {
	name: "alef.directive.enable",
	description: "Enable a system prompt block.",
	inputSchema: z.object({ id: z.string().min(1) }),
} as const;

const DIRECTIVE_DISABLE = {
	name: "alef.directive.disable",
	description: "Disable a system prompt block.",
	inputSchema: z.object({ id: z.string().min(1) }),
} as const;

const DIRECTIVE_TOGGLE = {
	name: "alef.directive.toggle",
	description: "Toggle a system prompt block on or off.",
	inputSchema: z.object({ id: z.string().min(1) }),
} as const;

const DIRECTIVE_REPLACE = {
	name: "alef.directive.replace",
	description: "Replace the content of a system prompt block.",
	inputSchema: z.object({ id: z.string().min(1), content: z.string().min(1) }),
} as const;

const DIRECTIVE_ADD = {
	name: "alef.directive.add",
	description: "Add a new block to the system prompt.",
	inputSchema: z.object({
		id: z.string().min(1),
		priority: z.number(),
		content: z.string().min(1),
		tags: z.array(z.string()).optional(),
	}),
} as const;

const DIRECTIVE_REMOVE = {
	name: "alef.directive.remove",
	description: "Remove a block from the prompt scroll.",
	inputSchema: z.object({ id: z.string().min(1) }),
} as const;

/**
 *
 */
function buildDirectiveTools(g: NonNullable<MetaAdapterOptions["getDirective"]>): ActionMap {
	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleDirectiveList(): Promise<Record<string, unknown>> {
		const blocks = g()?.list() ?? [];
		return withDisplay({ blocks }, { text: `${blocks.length} directive block(s)`, mimeType: "text/plain" });
	}

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleDirectiveEnable(
		ctx: CommandHandlerCtx<z.infer<typeof DIRECTIVE_ENABLE.inputSchema>>,
	): Promise<Record<string, unknown>> {
		g()?.enable(ctx.payload.id);
		return withDisplay(
			{ ok: true },
			{ text: `Enabled directive: ${ctx.payload.id}`, mimeType: "text/plain" },
		);
	}

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleDirectiveDisable(
		ctx: CommandHandlerCtx<z.infer<typeof DIRECTIVE_DISABLE.inputSchema>>,
	): Promise<Record<string, unknown>> {
		g()?.disable(ctx.payload.id);
		return withDisplay(
			{ ok: true },
			{ text: `Disabled directive: ${ctx.payload.id}`, mimeType: "text/plain" },
		);
	}

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleDirectiveToggle(
		ctx: CommandHandlerCtx<z.infer<typeof DIRECTIVE_TOGGLE.inputSchema>>,
	): Promise<Record<string, unknown>> {
		g()?.toggle(ctx.payload.id);
		return withDisplay(
			{ ok: true },
			{ text: `Toggled directive: ${ctx.payload.id}`, mimeType: "text/plain" },
		);
	}

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleDirectiveReplace(
		ctx: CommandHandlerCtx<z.infer<typeof DIRECTIVE_REPLACE.inputSchema>>,
	): Promise<Record<string, unknown>> {
		g()?.replace(ctx.payload.id, ctx.payload.content);
		return withDisplay(
			{ ok: true },
			{ text: `Replaced directive: ${ctx.payload.id}`, mimeType: "text/plain" },
		);
	}

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleDirectiveAdd(
		ctx: CommandHandlerCtx<z.infer<typeof DIRECTIVE_ADD.inputSchema>>,
	): Promise<Record<string, unknown>> {
		g()?.add(ctx.payload.id, ctx.payload.priority, ctx.payload.content, ctx.payload.tags);
		return withDisplay(
			{ ok: true },
			{
				text: `Added directive: ${ctx.payload.id} (priority ${ctx.payload.priority})`,
				mimeType: "text/plain",
			},
		);
	}

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleDirectiveRemove(
		ctx: CommandHandlerCtx<z.infer<typeof DIRECTIVE_REMOVE.inputSchema>>,
	): Promise<Record<string, unknown>> {
		g()?.remove(ctx.payload.id);
		return withDisplay(
			{ ok: true },
			{ text: `Removed directive: ${ctx.payload.id}`, mimeType: "text/plain" },
		);
	}

	return {
		command: {
			"alef.directive.list": typedAction(DIRECTIVE_LIST, handleDirectiveList),
			"alef.directive.enable": typedAction(DIRECTIVE_ENABLE, handleDirectiveEnable),
			"alef.directive.disable": typedAction(DIRECTIVE_DISABLE, handleDirectiveDisable),
			"alef.directive.toggle": typedAction(DIRECTIVE_TOGGLE, handleDirectiveToggle),
			"alef.directive.replace": typedAction(DIRECTIVE_REPLACE, handleDirectiveReplace),
			"alef.directive.add": typedAction(DIRECTIVE_ADD, handleDirectiveAdd),
			"alef.directive.remove": typedAction(DIRECTIVE_REMOVE, handleDirectiveRemove),
		},
	};
}

const SESSIONS_LIST = {
	name: "alef.sessions.list",
	description: "List all Alef sessions across all working directories, newest first.",
	inputSchema: z.object({}),
} as const;

const SESSIONS_SEARCH = {
	name: "alef.sessions.search",
	description: "Search sessions by keyword across name, first message, and conversation content.",
	inputSchema: z.object({ query: z.string().min(1).describe("Keyword or phrase to search for") }),
} as const;

const SESSIONS_RENAME = {
	name: "alef.sessions.rename",
	description: "Give a session a human-readable name so it can be found later.",
	inputSchema: z.object({
		id: z.string().min(1).describe("8-char session ID"),
		name: z.string().min(1).describe("Concise descriptive name, e.g. 'ToolShell eval and amnesia fix'"),
	}),
} as const;

const SESSIONS_READ = {
	name: "alef.sessions.read",
	description: "Read the first N turns of a session by ID.",
	inputSchema: z.object({
		id: z.string().min(1).describe("8-char session ID"),
		maxTurns: z.number().optional().default(10).describe("Max turns to return (default 10)"),
	}),
} as const;

const CONFIG_GET = {
	name: "alef.config.get",
	description: "Get the current Alef config from ~/.config/alef/config.yaml.",
	inputSchema: z.object({}),
} as const;

const ADAPTERS_LIST = {
	name: "alef.adapters.list",
	description: "List user-installed adapters from ~/.config/alef/adapters.yaml.",
	inputSchema: z.object({}),
} as const;

const PM_HISTORY = {
	name: "alef.pm.history",
	description: "List adapter package manager generation history.",
	inputSchema: z.object({}),
} as const;

const ALEF_REBUILD = {
	name: "alef.rebuild",
	description:
		"Trigger a blue-green rebuild: runs npm run check, spawns a new green with the same session, " +
		"and promotes it if healthy. Only available when running under the supervisor (alef-dev.sh). " +
		"Use after editing source files to apply the fix without losing session context.",
	inputSchema: z.object({}),
} as const;

/**
 *
 */
function buildSessionTools(opts: MetaAdapterOptions): ActionMap {
	/**
	 *
	 */
	async function handleSessionsList(): Promise<Record<string, unknown>> {
		const sessions = await listAllSessions(opts.dialogEventType);
		return withDisplay({ sessions }, { text: `${sessions.length} session(s)`, mimeType: "text/plain" });
	}

	/**
	 *
	 */
	async function handleSessionsSearch(
		ctx: CommandHandlerCtx<z.infer<typeof SESSIONS_SEARCH.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const results = await searchSessions(ctx.payload.query, opts.dialogEventType);
		return withDisplay(
			{ results },
			{ text: `${results.length} session(s) matching "${ctx.payload.query}"`, mimeType: "text/plain" },
		);
	}

	/**
	 *
	 */
	async function handleSessionsRename(
		ctx: CommandHandlerCtx<z.infer<typeof SESSIONS_RENAME.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const result = await renameSession(ctx.payload.id, ctx.payload.name);
		return withDisplay(result, {
			text: result.ok
				? `Renamed session ${ctx.payload.id} to "${ctx.payload.name}"`
				: `Rename failed: ${result.error}`,
			mimeType: "text/plain",
		});
	}

	/**
	 *
	 */
	async function handleSessionsRead(
		ctx: CommandHandlerCtx<z.infer<typeof SESSIONS_READ.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const turns = await readSessionTurns(ctx.payload.id, opts.dialogEventType, ctx.payload.maxTurns);
		return withDisplay(
			{ turns },
			{ text: `${turns.length} turn(s) from session ${ctx.payload.id}`, mimeType: "text/plain" },
		);
	}

	/**
	 *
	 */
	async function handleConfigGet(): Promise<Record<string, unknown>> {
		const config = await getConfig();
		return withDisplay({ config }, { text: "Alef config loaded", mimeType: "text/plain" });
	}

	/**
	 *
	 */
	async function handleAdaptersList(): Promise<Record<string, unknown>> {
		const adapters = await listAdapters();
		return withDisplay({ adapters }, { text: "adapters.yaml loaded", mimeType: "text/plain" });
	}

	/**
	 *
	 */
	async function handlePmHistory(): Promise<Record<string, unknown>> {
		const history = await pmHistory();
		return withDisplay(
			{ history },
			{ text: `${history.length} generation(s) in PM history`, mimeType: "text/plain" },
		);
	}

	/**
	 *
	 */
	// eslint-disable-next-line @typescript-eslint/require-await
	async function handleRebuild(
		ctx: CommandHandlerCtx<z.infer<typeof ALEF_REBUILD.inputSchema>>,
	): Promise<Record<string, unknown>> {
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
	}

	return {
		command: {
			"alef.sessions.list": typedAction(SESSIONS_LIST, handleSessionsList, { shouldCache: () => false }),
			"alef.sessions.search": typedAction(SESSIONS_SEARCH, handleSessionsSearch),
			"alef.sessions.rename": typedAction(SESSIONS_RENAME, handleSessionsRename),
			"alef.sessions.read": typedAction(SESSIONS_READ, handleSessionsRead),
			"alef.config.get": typedAction(CONFIG_GET, handleConfigGet, { shouldCache: () => true }),
			"alef.adapters.list": typedAction(ADAPTERS_LIST, handleAdaptersList, { shouldCache: () => true }),
			"alef.pm.history": typedAction(PM_HISTORY, handlePmHistory, { shouldCache: () => true }),
			"alef.rebuild": typedAction(ALEF_REBUILD, handleRebuild),
		},
	};
}

/**
 *
 */
export function createMetaAdapter(opts: MetaAdapterOptions) {
	const { agent, loadAdapter, cwd = process.cwd(), getDirective } = opts;
	return defineAdapter(
		"alef",
		{
			command: {
				...(getDirective ? buildDirectiveTools(getDirective).command : {}),
				...(agent && loadAdapter ? buildPrototypeTools(agent, loadAdapter, cwd).command : {}),
				...buildSessionTools(opts).command,
			},
		},
		{
			description:
				"Query Alef sessions, config, adapters, package manager history, manage the system prompt, and prototype new adapters.",
			skills: [PROTOTYPING_BOOK],
			directives: [
				"Use alef.sessions.list to discover all sessions. Use alef.sessions.search to find sessions by topic — it searches name, first message, and content. " +
					"Use alef.sessions.read to get the content of a specific session. " +
					"Use alef.sessions.rename to give a session a memorable name when asked. " +
					"Use alef.config.get, alef.adapters.list, alef.pm.history for system information. " +
					"Use alef.directive.list to show the active prompt blocks. Use alef.directive.enable/disable/toggle to change which blocks are active. " +
					"Use alef.directive.replace to change block content. Use alef.directive.add to inject a new block. " +
					"Use alef.rebuild to apply source edits via a zero-downtime blue-green swap (requires alef-dev.sh). " +
					"Use prototype.plug to load a new adapter at runtime (pass path or code). Use prototype.unplug to remove it. Use prototype.list to see what is loaded. " +
					"Respond concisely with the most relevant data. Do not write files.",
			],
			labels: ["alef-api", "meta", "sessions", "scroll"],
		},
	);
}
