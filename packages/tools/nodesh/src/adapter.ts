/**
 * NodeshAdapter — JavaScript REPL adapter.
 *
 * nodesh.eval — evaluates a JS expression or statement block in a fresh
 * vm.createContext seeded from the configured prelude. Returns structured
 * JSON result on Event. No persistent state between calls.
 *
 * Security model:
 *   - Fresh context per call — no leaked variables between turns.
 *   - Built-in modules allowed by explicit allowlist (default: fs, path, url,
 *     crypto, util, node:* safe subset). child_process is blocked.
 *   - Configurable timeout (default: 10s, hard cap: 30s).
 *   - require() and import() inside the sandbox resolve against the allowlist.
 *
 * Use cases:
 *   - Structured computation: data transforms, math, JSON manipulation.
 *   - Alef API introspection: call getModels(), inspect session state.
 *   - NOT for system tasks — use shell.exec for compilation, git, process mgmt.
 */

import vm from "node:vm";
import type { Adapter, BaseAdapterOptions } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const NODESH_EVAL_TOOL = {
	name: "nodesh.eval",
	description:
		"Evaluate a JavaScript expression or statement block. Returns a structured result object. " +
		"Prefer this over shell.exec for data processing, JSON manipulation, math, and Alef API calls. " +
		"Use shell.exec for system commands (git, npm, compilation).",
	inputSchema: z.object({
		code: z
			.string()
			.describe(
				"JavaScript code to evaluate. The last expression is the return value. " +
					"Use `result = ...` to explicitly set the return value for statement blocks.",
			),
		timeout: z.number().optional().describe("Timeout in seconds (default: 10, max: 30)"),
	}),
};

// ---------------------------------------------------------------------------
// Allowed built-in modules
// ---------------------------------------------------------------------------

/** Modules the sandbox may require(). child_process intentionally absent. */
const ALLOWED_BUILTINS = new Set([
	"node:path",
	"path",
	"node:url",
	"url",
	"node:crypto",
	"crypto",
	"node:util",
	"util",
	"node:buffer",
	"buffer",
	"node:stream",
	"stream",
	"node:events",
	"events",
	"node:querystring",
	"querystring",
	"node:string_decoder",
	"string_decoder",
	"node:os",
	"os",
]);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const DEFAULT_NODESH_TIMEOUT_S = 10;
export const MAX_NODESH_TIMEOUT_S = 30;

export interface NodeshAdapterOptions extends BaseAdapterOptions {
	cwd: string;
	/**
	 * Prelude code evaluated once to seed each fresh context.
	 * Example: "const { readFileSync } = require('node:fs');"
	 * All prelude bindings are available to every eval call.
	 */
	prelude?: string;
	/**
	 * Additional built-in modules to allow beyond the default safe set.
	 * "node:fs" and "node:fs/promises" are the most common additions.
	 */
	extraAllowedModules?: readonly string[];
	/** Default timeout in seconds. Default: 10. */
	defaultTimeoutSeconds?: number;
	/** Hard cap on LLM-supplied timeout. Default: 30. */
	maxTimeoutSeconds?: number;
}

// ---------------------------------------------------------------------------
// Sandboxed require
// ---------------------------------------------------------------------------

function makeSandboxedRequire(allowed: Set<string>): (mod: string) => unknown {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate dynamic require inside sandbox
	const nodeRequire =
		typeof require !== "undefined"
			? require
			: (mod: string) => {
					throw new Error(`require not available: ${mod}`);
				};
	return (mod: string) => {
		const normalized = mod.startsWith("node:") ? mod : mod;
		if (!allowed.has(normalized) && !allowed.has(`node:${normalized}`)) {
			throw new Error(`nodesh.eval: module '${mod}' is not in the allowlist`);
		}
		return nodeRequire(mod.startsWith("node:") ? mod : `node:${mod.replace(/^node:/, "")}`);
	};
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleEval(
	ctx: { payload: { code: string; timeout?: number } },
	opts: NodeshAdapterOptions,
): Promise<Record<string, unknown>> {
	const { code, timeout } = ctx.payload;
	if (!code.trim()) throw new Error("nodesh.eval: code is required");

	const defaultS = opts.defaultTimeoutSeconds ?? DEFAULT_NODESH_TIMEOUT_S;
	const maxS = opts.maxTimeoutSeconds ?? MAX_NODESH_TIMEOUT_S;
	const requestedS = timeout ?? defaultS;
	const timeoutMs = Math.min(requestedS, maxS) * 1000;

	const allowed = new Set([...ALLOWED_BUILTINS, ...(opts.extraAllowedModules ?? [])]);

	// Fresh context per call — no state leaks between LLM turns.
	const sandbox: Record<string, unknown> = {
		require: makeSandboxedRequire(allowed),
		console: {
			log: (...args: unknown[]) => {
				stdout.push(args.map(String).join(" "));
			},
			error: (...args: unknown[]) => {
				stdout.push(`[error] ${args.map(String).join(" ")}`);
			},
			warn: (...args: unknown[]) => {
				stdout.push(`[warn] ${args.map(String).join(" ")}`);
			},
		},
		process: { cwd: () => opts.cwd, env: { ...process.env }, platform: process.platform },
		result: undefined as unknown,
	};

	const context = vm.createContext(sandbox);
	const stdout: string[] = [];

	// Run prelude if configured.
	if (opts.prelude?.trim()) {
		vm.runInContext(opts.prelude, context, { timeout: timeoutMs, filename: "<prelude>" });
	}

	// For async code: wrap in IIFE (top-level await). For sync: REPL-style
	// vm.runInContext returns the completion value of the last statement directly.
	const hasAwait = /\bawait\b/.test(code);
	let returnValue: unknown;
	if (hasAwait) {
		const wrapped = `(async () => { ${code} })()`;
		returnValue = await vm.runInContext(wrapped, context, { timeout: timeoutMs, filename: "<nodesh>" });
	} else {
		returnValue = vm.runInContext(code, context, { timeout: timeoutMs, filename: "<nodesh>" });
	}

	// Explicit `result = ...` wins; otherwise use the expression return value.
	const finalResult = sandbox.result !== undefined ? sandbox.result : returnValue;

	const serialized = safeSerialize(finalResult);
	const resultLine = `result: ${JSON.stringify(serialized)}`;
	const stdoutSection = stdout.length > 0 ? `\nstdout:\n${stdout.join("\n")}` : "";
	return withDisplay(
		{ result: serialized, stdout: stdout.join("\n"), type: typeof finalResult },
		{ text: `${resultLine}${stdoutSection}`, mimeType: "text/plain" },
	);
}

/** Serialize result safely — circular refs and non-JSON types handled. */
function safeSerialize(value: unknown): unknown {
	if (value === undefined) return null;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return String(value);
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNodeshAdapter(options: NodeshAdapterOptions): Adapter {
	return defineAdapter(
		"nodesh",
		{
			command: { "nodesh.eval": typedAction(NODESH_EVAL_TOOL, (ctx) => handleEval(ctx, options)) },
		},
		{
			actions: options.actions,
			directives: NODESH_DIRECTIVES,
			logger: options.logger,
			description: "JavaScript REPL adapter for structured computation and Alef API introspection.",
			labels: ["nodesh", "javascript", "repl", "computation", "experimental"],
			publishSchemas: {
				event: {
					"nodesh.eval": z.object({
						result: z.unknown(),
						stdout: z.string().min(1),
						type: z.string().min(1),
					}),
				},
			},
		},
	);
}

const NODESH_DIRECTIVES = [
	`**nodesh.eval tool guidance**
- Use nodesh.eval for: data transformation, JSON manipulation, math, string processing, and Alef API calls.
- Use shell.exec for: running tests, git commands, npm installs, and any system process management.
- Each eval runs in a fresh context — variables do not persist between calls. Use result = ... for explicit return.
- Modules available by default: path, url, crypto, util, buffer, os, events. Ask for fs if file access is needed.
- child_process is intentionally blocked. Use shell.exec for process execution.
- Return structured data (objects, arrays) rather than printing strings — the result field carries the value.`,
];
