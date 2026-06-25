#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const supervisorJs = resolve(__dirname, "../dist/supervisor.js");

const child = spawn(process.execPath, [supervisorJs, ...process.argv.slice(2)], {
	env: process.env,
	stdio: "inherit",
});

child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});
