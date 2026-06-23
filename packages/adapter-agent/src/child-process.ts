import { type ChildProcess, execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { blueprintRegistry } from "@dpopsuev/alef-agent-blueprint";
import { stringify as stringifyYaml } from "yaml";

export interface ChildEntry {
	name: string;
	endpoint: string;
	sessionId: string | undefined;
	pid: number;
	process: ChildProcess;
	startedAt: number;
	tmpDir?: string;
}

const RUNNER_MAIN = new URL("../../runner/src/main.ts", import.meta.url).pathname;
const TSX_BIN = new URL("../../../node_modules/.bin/tsx", import.meta.url).pathname;

export function resolvePath(p: string, base: string): string {
	return isAbsolute(p) ? p : resolve(base, p);
}

function detectBwrap(): string | null {
	try {
		return (
			execSync("which bwrap", { stdio: ["ignore", "pipe", "ignore"] })
				.toString()
				.trim() || null
		);
	} catch {
		return null;
	}
}

const BWRAP_PATH = detectBwrap();

function wrapWithBwrap(cmd: string[]): [string, string[]] {
	if (!BWRAP_PATH) throw new Error("sandbox: true requires bwrap (bubblewrap) — not found on PATH");
	return [
		BWRAP_PATH,
		[
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--proc",
			"/proc",
			"--tmpfs",
			"/tmp",
			"--unshare-net",
			"--die-with-parent",
			"--",
			...cmd,
		],
	];
}

export function waitForReady(
	child: ChildProcess,
	timeoutMs: number,
): Promise<{ endpoint: string; sessionId: string | undefined }> {
	return new Promise((resolveP, rejectP) => {
		let endpoint = "";
		let sessionId: string | undefined;
		const stderrLines: string[] = [];
		// lint-ignore: RAWTIMER child readiness one-shot deadline
		const timer = setTimeout(() => rejectP(new Error("Child readiness timeout")), timeoutMs);

		const scan = (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString();
			const sessionMatch = text.match(/\[session\]\s+(\S+)/);
			if (sessionMatch) sessionId = sessionMatch[1];
			const routerMatch = text.match(/router listening on (http:\/\/[\d.]+:\d+)/);
			if (routerMatch) {
				endpoint = routerMatch[1];
				clearTimeout(timer);
				child.stdout?.off("data", scan);
				child.stderr?.off("data", scanStderr);
				resolveP({ endpoint, sessionId });
			}
		};

		const scanStderr = (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString();
			stderrLines.push(text);
			scan(chunk);
		};

		child.stdout?.on("data", scan);
		child.stderr?.on("data", scanStderr);
		child.once("exit", (code) => {
			clearTimeout(timer);
			const detail = stderrLines.length > 0 ? `\n${stderrLines.join("").trim()}` : "";
			rejectP(new Error(`Child exited (${code}) before ready${detail}`));
		});
	});
}

export function healthCheck(endpoint: string): Promise<boolean> {
	return new Promise((res) => {
		http.get(`${endpoint}/health`, (resp) => res(resp.statusCode === 200)).on("error", () => res(false));
	});
}

export interface SpawnChildOptions {
	cwd: string;
	blueprintPath?: string;
	adapters?: string[];
	childCwd?: string;
	sessionId?: string;
	sandbox?: boolean;
	readinessTimeoutMs: number;
	writableRoots?: readonly string[];
	/** Depth level to propagate to the child (child reads via ALEF_AGENT_DEPTH). */
	childDepth?: number;
}

export async function spawnChild(
	opts: SpawnChildOptions,
): Promise<{ child: ChildProcess; endpoint: string; sessionId: string | undefined; tmpDir?: string }> {
	const childCwd = opts.childCwd ?? opts.cwd;
	const adapterPaths = opts.adapters ?? [];

	// Check if blueprintPath is a registered blueprint name (e.g., YAML blueprints)
	// If so, keep it as a name; otherwise resolve it as a file path
	let blueprintPath: string | undefined;
	if (opts.blueprintPath) {
		const registeredNames = blueprintRegistry.list();
		blueprintPath = registeredNames.includes(opts.blueprintPath)
			? opts.blueprintPath // Keep as blueprint name
			: resolvePath(opts.blueprintPath, childCwd); // Resolve as file path
	}

	let tmpDir: string | undefined;

	if (adapterPaths.length > 0 && !blueprintPath) {
		tmpDir = mkdtempSync(join(tmpdir(), "alef-sup-"));
		blueprintPath = join(tmpDir, "agent.yaml");
		writeFileSync(
			blueprintPath,
			stringifyYaml({
				apiVersion: "alef.dpopsuev.io/v1alpha1",
				kind: "AgentRuntime",
				metadata: { name: "staging" },
				spec: { adapters: adapterPaths.map((p) => ({ path: resolvePath(p, childCwd) })) },
			}),
			"utf-8",
		);
	}

	const args = [TSX_BIN, RUNNER_MAIN, "--serve", "0", "--no-tui"];
	if (blueprintPath) args.push("--blueprint", blueprintPath);
	if (opts.sessionId) args.push("--resume", opts.sessionId);

	const alefNodeModules = new URL("../../../node_modules", import.meta.url).pathname;
	const nodePath = [alefNodeModules, process.env.NODE_PATH].filter(Boolean).join(delimiter);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		ALEF_SUPERVISOR: "1",
		NODE_PATH: nodePath,
		...(opts.writableRoots ? { ALEF_WRITABLE_ROOTS: JSON.stringify(opts.writableRoots) } : {}),
		...(opts.childDepth !== undefined ? { ALEF_AGENT_DEPTH: String(opts.childDepth) } : {}),
		...(process.env.TSX_TSCONFIG_PATH
			? {}
			: {
					TSX_TSCONFIG_PATH: new URL("../../../tsconfig.json", import.meta.url).pathname,
				}),
	};

	const sandbox = opts.sandbox ?? false;
	const [spawnCmd, spawnArgs] = sandbox ? wrapWithBwrap([process.execPath, ...args]) : [process.execPath, args];
	const child = spawn(spawnCmd, spawnArgs, { cwd: childCwd, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });

	try {
		const ready = await waitForReady(child, opts.readinessTimeoutMs);
		return { child, endpoint: ready.endpoint, sessionId: ready.sessionId, tmpDir };
	} catch (err) {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
		child.kill("SIGTERM");
		throw err;
	}
}
