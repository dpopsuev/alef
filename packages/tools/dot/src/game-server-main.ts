#!/usr/bin/env node
/**
 * Standalone Dot-circle game process.
 * Usage: npx tsx packages/tools/dot/src/game-server-main.ts [--port 0] [--seed 1]
 * Prints: PORT=<n>
 */
import { startDotGameServer } from "./game-server.js";

/** Read a CLI flag value. */
function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	if (index < 0) return undefined;
	return process.argv[index + 1];
}

const port = Number(argValue("--port") ?? "0");
const seed = Number(argValue("--seed") ?? "1");
const radius = Number(argValue("--radius") ?? "5");
const force = Number(argValue("--force") ?? "2.5");

const server = await startDotGameServer({ port, seed, radius, force });
process.stdout.write(`PORT=${server.port}\n`);

const shutdown = () => {
	void server.close().finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
