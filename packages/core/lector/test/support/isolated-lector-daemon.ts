import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connectLectorClientAt, type LectorClient } from "@danypops/lector";

/**
 * Boots a real, isolated Lector daemon for tests -- a genuine Bun subprocess, not an
 * in-process fake. Lector's daemon runtime (startDaemon from @danypops/daemon-kit)
 * calls Bun.serve() internally, so it can only ever run under an actual `bun` process;
 * Alef's own vitest suite runs under Node, so this is a real cross-runtime boundary,
 * not a test-only shortcut -- production Alef (Node) always talks to a separately
 * running Bun-run Lector daemon this same way.
 */
export interface IsolatedLectorDaemon {
	readonly client: LectorClient;
	readonly workspaceRoot: string;
	stop(): Promise<void>;
}

const STARTUP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 50;

function resolveLectorCliPath(): string {
	const require = createRequire(import.meta.url);
	const packageJsonPath = require.resolve("@danypops/lector/package.json");
	return join(dirname(packageJsonPath), "src", "cli.ts");
}

async function waitForFile(path: string, deadline: number): Promise<void> {
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}

export async function startIsolatedLectorDaemon(): Promise<IsolatedLectorDaemon> {
	const xdgRoot = mkdtempSync(join(tmpdir(), "alef-lector-test-xdg-"));
	const workspaceRoot = mkdtempSync(join(tmpdir(), "alef-lector-test-ws-"));
	const handlePath = join(xdgRoot, "lector", "handle.json");
	const tokenPath = join(xdgRoot, "lector", "token");

	const child: ChildProcess = spawn("bun", [resolveLectorCliPath(), "serve", "--workspace-path", `bootstrap=${workspaceRoot}`], {
		env: {
			...process.env,
			XDG_DATA_HOME: xdgRoot,
			XDG_STATE_HOME: xdgRoot,
			XDG_RUNTIME_DIR: xdgRoot,
			XDG_CONFIG_HOME: xdgRoot,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	try {
		await waitForFile(handlePath, deadline);
		await waitForFile(tokenPath, deadline);
	} catch (error) {
		child.kill();
		throw new Error(`Lector daemon did not start in time: ${String(error)}\nstderr: ${stderr}`);
	}

	const handle = JSON.parse(readFileSync(handlePath, "utf8")) as { host: string; port: number };
	const token = readFileSync(tokenPath, "utf8").trim();
	const client = connectLectorClientAt(`http://${handle.host}:${handle.port}`, token);
	await client.health();

	return {
		client,
		workspaceRoot,
		stop: async () => {
			child.kill();
			await new Promise((resolve) => child.once("exit", resolve));
			rmSync(xdgRoot, { recursive: true, force: true });
			rmSync(workspaceRoot, { recursive: true, force: true });
		},
	};
}
