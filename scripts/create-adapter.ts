#!/usr/bin/env tsx
/**
 * Scaffold a new organ package with all required files.
 *
 * Usage: npx tsx scripts/create-organ.ts <name> [tool-name]
 * Example: npx tsx scripts/create-organ.ts weather weather.forecast
 *
 * Creates packages/adapter-<name>/ with:
 *   src/organ.ts       — defineOrgan scaffold with one tool
 *   src/index.ts       — barrel export
 *   test/organ.test.ts — compliance suite
 *   package.json       — workspace package
 *   vitest.config.ts   — test config
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const name = process.argv[2];
if (!name) {
	console.error("Usage: npx tsx scripts/create-organ.ts <name> [tool-name]");
	process.exit(1);
}

const toolName = process.argv[3] ?? `${name}.run`;
const pkgDir = join(process.cwd(), "packages", `adapter-${name}`);

mkdirSync(join(pkgDir, "src"), { recursive: true });
mkdirSync(join(pkgDir, "test"), { recursive: true });

writeFileSync(
	join(pkgDir, "src", "organ.ts"),
	`import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";

export interface ${pascal(name)}OrganOptions {
\tcwd: string;
}

const TOOL = {
\tname: "${toolName}",
\tdescription: "TODO: describe what this tool does.",
\tinputSchema: z.object({
\t\tinput: z.string().min(1).describe("TODO: describe this parameter"),
\t}),
};

export function create${pascal(name)}Organ(opts: ${pascal(name)}OrganOptions) {
\treturn defineOrgan(
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
\t\t\tdescription: "TODO: one-sentence description of this organ.",
\t\t\tdirectives: ["TODO: guidance for the LLM on when and how to use ${toolName}."],
\t\t\tlabels: ["${name}"],
\t\t},
\t);
}
`,
);

writeFileSync(
	join(pkgDir, "src", "index.ts"),
	`export { create${pascal(name)}Organ, create${pascal(name)}Organ as createOrgan, type ${pascal(name)}OrganOptions } from "./organ.js";
`,
);

writeFileSync(
	join(pkgDir, "test", "organ.test.ts"),
	`import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { create${pascal(name)}Organ } from "../src/organ.js";

adapterComplianceSuite(() => create${pascal(name)}Organ({ cwd: "/tmp" }));
`,
);

writeFileSync(
	join(pkgDir, "package.json"),
	JSON.stringify(
		{
			name: `@dpopsuev/alef-adapter-${name}`,
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
console.log(`  src/organ.ts       — defineOrgan with ${toolName} tool`);
console.log(`  src/index.ts       — barrel export`);
console.log(`  test/organ.test.ts — compliance suite`);
console.log(`  package.json       — workspace package`);
console.log(`  vitest.config.ts   — test config`);
console.log();
console.log("Next steps:");
console.log("  1. npm install");
console.log(`  2. Add "${name}" to your blueprint's organs list`);
console.log(`  3. cd packages/adapter-${name} && npx vitest run`);

function pascal(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
