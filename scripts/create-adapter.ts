#!/usr/bin/env tsx
/**
 * Scaffold a new adapter package with all required files.
 *
 * Usage: npx tsx scripts/create-adapter.ts <name> [tool-name]
 * Example: npx tsx scripts/create-adapter.ts weather weather.forecast
 *
 * Creates packages/tools/<name>/ with:
 *   src/adapter.ts       — defineAdapter scaffold with one tool
 *   src/index.ts       — barrel export
 *   test/adapter.test.ts — compliance suite
 *   package.json       — workspace package
 *   vitest.config.ts   — test config
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const name = process.argv[2];
if (!name) {
	console.error("Usage: npx tsx scripts/create-adapter.ts <name> [tool-name]");
	process.exit(1);
}

const toolName = process.argv[3] ?? `${name}.run`;
const pkgDir = join(process.cwd(), "packages", "tools", name);

mkdirSync(join(pkgDir, "src"), { recursive: true });
mkdirSync(join(pkgDir, "test"), { recursive: true });

writeFileSync(
	join(pkgDir, "src", "adapter.ts"),
	`import { defineAdapter, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";

export interface ${pascal(name)}AdapterOptions {
\tcwd: string;
}

const TOOL = {
\tname: "${toolName}",
\tdescription: "TODO: describe what this tool does.",
\tinputSchema: z.object({
\t\tinput: z.string().min(1).describe("TODO: describe this parameter"),
\t}),
};

export function create${pascal(name)}Adapter(opts: ${pascal(name)}AdapterOptions) {
\treturn defineAdapter(
\t\t"${name}",
\t\t{
\t\t\tmotor: {
\t\t\t\t"${toolName}": typedAction(TOOL, async (ctx) => {
\t\t\t\t\tconst { input } = ctx.payload;
\t\t\t\t\treturn withDisplay({ input }, { text: \`${toolName}: \${input}\`, mimeType: "text/plain" });
\t\t\t\t}),
\t\t\t},
\t\t},
\t\t{
\t\t\tdescription: "TODO: one-sentence description of this adapter.",
\t\t\tdirectives: ["TODO: guidance for the LLM on when and how to use ${toolName}."],
\t\t\tlabels: ["${name}"],
\t\t},
\t);
}
`,
);

writeFileSync(
	join(pkgDir, "src", "index.ts"),
	`export { create${pascal(name)}Adapter, create${pascal(name)}Adapter as createAdapter, type ${pascal(name)}AdapterOptions } from "./adapter.js";
`,
);

writeFileSync(
	join(pkgDir, "test", "adapter.test.ts"),
	`import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
import { create${pascal(name)}Adapter } from "../src/adapter.js";

adapterComplianceSuite(() => create${pascal(name)}Adapter({ cwd: "/tmp" }));
`,
);

writeFileSync(
	join(pkgDir, "package.json"),
	JSON.stringify(
		{
			name: `@dpopsuev/alef-tool-${name}`,
			version: "0.0.1",
			type: "module",
			main: "./src/index.ts",
			exports: { ".": { source: "./src/index.ts", default: "./src/index.ts" } },
			scripts: { test: "vitest --run" },
			dependencies: { "@dpopsuev/alef-kernel": "^0.0.1", "zod": "^4.4.3" },
			devDependencies: { "@dpopsuev/alef-testkit": "^0.0.1", vitest: "^4.1.6" },
		},
		null,
		2,
	) + "\n",
);

writeFileSync(
	join(pkgDir, "vitest.config.ts"),
	`import { defineProject, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.shared.js";

export default mergeConfig(sharedConfig, defineProject({ test: { name: "adapter-${name}" } }));
`,
);

console.log(`Created packages/adapter-${name}/`);
console.log(`  src/adapter.ts       — defineAdapter with ${toolName} tool`);
console.log(`  src/index.ts       — barrel export`);
console.log(`  test/adapter.test.ts — compliance suite`);
console.log(`  package.json       — workspace package`);
console.log(`  vitest.config.ts   — test config`);
console.log();
console.log("Next steps:");
console.log("  1. npm install");
console.log(`  2. Add "${name}" to your blueprint's adapters list`);
console.log(`  3. cd packages/adapter-${name} && npx vitest run`);

function pascal(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
