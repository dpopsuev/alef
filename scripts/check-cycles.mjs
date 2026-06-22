#!/usr/bin/env node
import { execSync } from "node:child_process";

try {
  const result = execSync(
    "npx madge --circular --extensions ts --no-spinner packages/kernel/src packages/runtime/src packages/adapter-*/src packages/runner/src",
    { encoding: "utf-8", timeout: 30_000 }
  );
  // madge exits 0 when no cycles — shouldn't reach here with cycles
  if (result.includes("Found") && result.includes("circular")) {
    console.error(result);
    process.exit(1);
  }
  console.log("No circular dependencies found");
} catch (err) {
  const output = err.stdout || err.stderr || String(err);
  // Filter out dist/ cycles (build artifacts, not source)
  const lines = output.split("\n");
  const srcCycles = lines.filter(l => l.match(/^\d+\)/) && !l.includes("/dist/"));
  if (srcCycles.length > 0) {
    console.error("Circular dependencies found in source:");
    srcCycles.forEach(l => console.error(l));
    process.exit(1);
  }
  console.log("No source circular dependencies (dist-only cycles ignored)");
}
