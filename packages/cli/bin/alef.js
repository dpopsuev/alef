#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use tsx for TypeScript source execution (dev); dist for production.
const entryTs = resolve(__dirname, "../src/entrypoint.ts");
const entryJs = resolve(__dirname, "../dist/entrypoint.js");

import { existsSync } from "node:fs";
if (existsSync(entryJs)) {
	await import(entryJs);
} else {
	const tsx = resolve(__dirname, "../node_modules/tsx/dist/cli.mjs");
	const { spawn } = await import("node:child_process");
	const child = spawn(process.execPath, [tsx, entryTs, ...process.argv.slice(2)], {
		env: process.env,
		stdio: "inherit",
	});
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
}
