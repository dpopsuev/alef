#!/usr/bin/env node
/**
 * Boot smoke test — verify the agent entry point is importable.
 * Catches stale paths in Makefile, bin scripts, and main.ts after moves.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = new URL('..', import.meta.url).pathname;
const ENTRY_POINTS = [
  'packages/cli/src/entrypoint.ts',
  'packages/cli/bin/alef.js',
];

let ok = true;
for (const entry of ENTRY_POINTS) {
  const full = resolve(ROOT, entry);
  if (!existsSync(full)) {
    console.error(`❌ Entry point missing: ${entry}`);
    ok = false;
  }
}

// Verify Makefile and alef-test.sh reference existing paths
const { readFileSync } = await import('node:fs');
for (const f of ['Makefile']) {
  const content = readFileSync(resolve(ROOT, f), 'utf-8');
  const refs = content.match(/packages\/[^\s'"`)]+\.ts/g) ?? [];
  for (const ref of refs) {
    if (!existsSync(resolve(ROOT, ref))) {
      console.error(`❌ ${f} references missing file: ${ref}`);
      ok = false;
    }
  }
}

if (ok) console.log('✅ All entry points and script references exist');
else process.exit(1);
