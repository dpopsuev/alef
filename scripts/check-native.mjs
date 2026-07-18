#!/usr/bin/env node
/**
 * Gate native addons + Node major against .nvmrc (CI = 22).
 * Catches better-sqlite3 ABI drift when install Node ≠ runtime Node.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nvmrc = readFileSync(resolve(ROOT, ".nvmrc"), "utf8").trim();
const expectedMajor = Number(nvmrc.split(".")[0]);
const actualMajor = Number(process.versions.node.split(".")[0]);

if (!Number.isFinite(expectedMajor) || expectedMajor < 1) {
	console.error(`❌ Invalid .nvmrc (${nvmrc})`);
	process.exit(1);
}

if (actualMajor !== expectedMajor) {
	console.error(
		`❌ Node ${process.version} (ABI ${process.versions.modules}) — Alef expects Node ${expectedMajor}.x (see .nvmrc / CI)`,
	);
	console.error(`   Switch with: nvm use / fnm use / mise use, then: pnpm rebuild better-sqlite3`);
	process.exit(1);
}

const require = createRequire(resolve(ROOT, "packages/tools/code-intel/package.json"));
try {
	const Database = require("better-sqlite3");
	const db = new Database(":memory:");
	db.prepare("select 1 as x").get();
	db.close();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(
		`❌ better-sqlite3 failed under Node ${process.version} (ABI ${process.versions.modules})`,
	);
	console.error(`   ${message.split("\n")[0]}`);
	console.error(
		"   Fix: PATH=\"/usr/bin:$PATH\" pnpm rebuild better-sqlite3",
	);
	console.error(
		"   Or:  cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npm run install",
	);
	process.exit(1);
}

console.log(
	`✅ Native modules OK (Node ${process.version}, ABI ${process.versions.modules}, expect ${expectedMajor}.x)`,
);
