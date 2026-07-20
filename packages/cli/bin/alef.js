#!/usr/bin/env node
/**
 * Alef CLI entry point.
 *
 * Resolves the entrypoint (dist/ for production, tsx for dev) and runs it.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

const entryTs = resolve(__dirname, "../src/entrypoint.ts");
const entryJs = resolve(__dirname, "../dist/entrypoint.js");

if (existsSync(entryJs)) {
	await import(entryJs);
} else {
	const tsx = resolve(__dirname, "../node_modules/tsx/dist/cli.mjs");
	const child = spawn(process.execPath, [tsx, entryTs, ...process.argv.slice(2)], {
		env: process.env,
		stdio: "inherit",
	});
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
}
