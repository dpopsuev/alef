/**
 * alef organ new <name> — scaffold a publishable organ package.
 *
 * Generates in the current working directory:
 *   alef-organ-<name>/
 *     src/organ.ts       ← defineOrgan() factory, createOrgan export
 *     package.json       ← name: alef-organ-<name>, keywords: [alef-organ]
 *     tsconfig.json
 *     README.md
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function writeOrganSource(name: string): string {
	return `import { defineOrgan } from "@dpopsuev/alef-spine";
import { z } from "zod";

const HELLO_TOOL = {
	name: "${name}.hello",
	description: "Say hello with an optional name.",
	inputSchema: z.object({ name: z.string().optional().describe("Name to greet") }),
};

export function createOrgan() {
	return defineOrgan(
		"${name}",
		{
			"motor/${name}.hello": {
				tool: HELLO_TOOL,
				handle: async (ctx) => {
					const { name = "world" } = ctx.payload as { name?: string };
					return { message: \`Hello, \${name}!\` };
				},
			},
		},
		{
			description: "${name} organ — describe what this organ does in one sentence.",
			directives: [
				"Use ${name}.hello to greet a user or entity by name. " +
					"Pass the name field when you know who to greet; omit it for a generic greeting.",
			],
			labels: ["${name}"],
		},
	);
}
`;
}

function writePackageJson(name: string, version: string): string {
	return JSON.stringify(
		{
			name: `alef-organ-${name}`,
			version,
			description: `${name} organ for Alef agents`,
			keywords: ["alef-organ"],
			type: "module",
			main: "dist/index.js",
			exports: { ".": "./dist/index.js" },
			scripts: {
				build: "tsc",
				check: "tsc --noEmit",
			},
			peerDependencies: {
				"@dpopsuev/alef-spine": "*",
				zod: "^3.0.0",
			},
			devDependencies: {
				typescript: "^5.0.0",
			},
		},
		null,
		2,
	);
}

function writeTsConfig(): string {
	return JSON.stringify(
		{
			extends: "../tsconfig.base.json",
			compilerOptions: {
				rootDir: "src",
				outDir: "dist",
				composite: false,
			},
			include: ["src/**/*"],
		},
		null,
		2,
	);
}

function writeReadme(name: string): string {
	return `# alef-organ-${name}

An Alef organ package.

## Install

\`\`\`
alef install alef-organ-${name}
\`\`\`

## Tools

| Tool | Description |
|------|-------------|
| \`${name}.hello\` | Say hello with an optional name |

## Usage in blueprint

\`\`\`yaml
organs:
  - name: ${name}
\`\`\`
`;
}

export function scaffoldOrgan(name: string, cwd: string, version = "0.1.0"): string {
	const dir = join(cwd, `alef-organ-${name}`);
	const srcDir = join(dir, "src");

	mkdirSync(srcDir, { recursive: true });

	writeFileSync(join(srcDir, "organ.ts"), writeOrganSource(name), "utf-8");
	writeFileSync(join(dir, "package.json"), writePackageJson(name, version), "utf-8");
	writeFileSync(join(dir, "tsconfig.json"), writeTsConfig(), "utf-8");
	writeFileSync(join(dir, "README.md"), writeReadme(name), "utf-8");

	return dir;
}
