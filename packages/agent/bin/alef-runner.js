#!/usr/bin/env node
// Alef EDA runner — entry point for global install.
// Uses tsx to run the TypeScript source directly (no build step required).

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Locate tsx — prefer the monorepo root node_modules, fall back to global.
const tsxCandidates = [
	join(__dirname, "../../../node_modules/tsx/dist/cli.mjs"),
	join(__dirname, "../node_modules/tsx/dist/cli.mjs"),
];

let tsxPath;
for (const c of tsxCandidates) {
	try {
		const { existsSync } = await import("node:fs");
		if (existsSync(c)) { tsxPath = c; break; }
	} catch {}
}

if (!tsxPath) {
	process.stderr.write("[alef] Error: tsx not found. Run: npm install\n");
	process.exit(1);
}

const supervisorTs = resolve(__dirname, "../src/supervisor.ts");
const tsconfig = resolve(__dirname, "../../../tsconfig.json");

const { spawn } = await import("node:child_process");
const child = spawn(
	process.execPath,
	[tsxPath, supervisorTs, ...process.argv.slice(2)],
	{
		env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
		stdio: "inherit",
	},
);

child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});
