/**
 * Dot game HTTP client and process spawner — no Alef imports.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DotSnapshot } from "./world.js";

/** Client for the remote Dot game server. */
export interface DotGameClient {
	observe(): Promise<DotSnapshot>;
	move(dx: number, dy: number): Promise<DotSnapshot>;
	reset(seed?: number): Promise<DotSnapshot>;
	tick(): Promise<DotSnapshot>;
}

/** Narrow unknown JSON into a DotSnapshot or throw. */
function asSnapshot(json: unknown): DotSnapshot {
	if (json === null || typeof json !== "object") throw new Error("dot game: expected snapshot object");
	const record: object = json;
	const x = "x" in record ? record.x : undefined;
	const y = "y" in record ? record.y : undefined;
	const radius = "radius" in record ? record.radius : undefined;
	const dist = "dist" in record ? record.dist : undefined;
	const inside = "inside" in record ? record.inside : undefined;
	const status = "status" in record ? record.status : undefined;
	const tick = "tick" in record ? record.tick : undefined;
	if (
		typeof x !== "number" ||
		typeof y !== "number" ||
		typeof radius !== "number" ||
		typeof dist !== "number" ||
		typeof inside !== "boolean" ||
		(status !== "ok" && status !== "game_over") ||
		typeof tick !== "number"
	) {
		throw new Error("dot game: malformed snapshot");
	}
	return { x, y, radius, dist, inside, status, tick };
}

/** HTTP client for the Dot game server. */
export function createDotGameClient(baseUrl: string): DotGameClient {
	const root = baseUrl.replace(/\/$/, "");

	/** Issue one HTTP request and parse a snapshot. */
	async function request(method: string, path: string, body?: unknown): Promise<DotSnapshot> {
		const response = await fetch(`${root}${path}`, {
			method,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const json: unknown = await response.json();
		if (!response.ok) {
			let message = response.statusText;
			if (json !== null && typeof json === "object" && "error" in json) {
				message = String(json.error);
			}
			throw new Error(`dot game ${method} ${path}: ${message}`);
		}
		return asSnapshot(json);
	}

	return {
		observe: () => request("GET", "/observe"),
		move: (dx, dy) => request("POST", "/move", { dx, dy }),
		reset: (seed) => request("POST", "/reset", seed === undefined ? {} : { seed }),
		tick: () => request("POST", "/tick"),
	};
}

/** Spawned game child process handle. */
export interface SpawnedDotGame {
	readonly baseUrl: string;
	readonly port: number;
	readonly child: ChildProcess;
	kill(): Promise<void>;
}

/** Spawn the game as a separate Node process; wait for PORT= line. */
export async function spawnDotGameProcess(opts: {
	seed?: number;
	radius?: number;
	force?: number;
	timeoutMs?: number;
} = {}): Promise<SpawnedDotGame> {
	const mainPath = fileURLToPath(new URL("./game-server-main.ts", import.meta.url));
	const args = [
		"--import",
		"tsx",
		mainPath,
		"--port",
		"0",
		"--seed",
		String(opts.seed ?? 1),
		"--radius",
		String(opts.radius ?? 5),
		"--force",
		String(opts.force ?? 2.5),
	];
	const child = spawn(process.execPath, args, {
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});

	const timeoutMs = opts.timeoutMs ?? 10_000;
	const port = await new Promise<number>((resolve, reject) => {
		let settled = false;
		// lint-ignore: RAWTIMER spawn deadline — fires once if the child never prints PORT=
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error(`spawnDotGameProcess: timed out after ${timeoutMs}ms waiting for PORT=`));
		}, timeoutMs);

		let stdout = "";
		const onData = (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			const match = /PORT=(\d+)/.exec(stdout);
			if (!match || settled) return;
			settled = true;
			clearTimeout(timer);
			child.stdout.off("data", onData);
			resolve(Number(match[1]));
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
		});
		child.on("exit", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`spawnDotGameProcess: exited early with code ${code}`));
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});
	});

	return {
		port,
		baseUrl: `http://127.0.0.1:${port}`,
		child,
		kill: async () => {
			if (child.killed || child.exitCode !== null) return;
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				// lint-ignore: RAWTIMER kill grace period before SIGKILL
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					resolve();
				}, 2_000);
				child.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		},
	};
}
