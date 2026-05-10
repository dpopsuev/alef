import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createSymbolOutlineToolDefinition } from "../src/core/tools/symbol-outline.js";

const noopCtx = undefined as unknown as ExtensionContext;

describe("symbol_outline tool", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-symbol-outline-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists imports and declarations for TypeScript", async () => {
		const filePath = join(tempDir, "sample.ts");
		writeFileSync(
			filePath,
			`import { x } from "./dep";

export function foo(): void {}
export class Bar {
  run(): void {}
}
`,
			"utf-8",
		);

		const def = createSymbolOutlineToolDefinition(tempDir);
		const result = await def.execute("id", { path: "sample.ts", memberDepth: 2 }, undefined, undefined, noopCtx);

		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toContain("## Imports");
		expect(text).toMatch(/\.\/dep/);
		expect(text).toMatch(/\bx\b/);
		expect(text).toContain("function foo");
		expect(text).toContain("class Bar");
		expect(text).toContain("method run");
	});

	it("rejects unsupported extensions", async () => {
		writeFileSync(join(tempDir, "x.py"), "def f(): pass\n", "utf-8");
		const def = createSymbolOutlineToolDefinition(tempDir);
		const result = await def.execute("id", { path: "x.py" }, undefined, undefined, noopCtx);
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toContain("unsupported extension");
	});
});
