/**
 * Foundry evaluations.
 *
 * The agent must build a small adapter-backed tool using the Foundry service
 * helper, then satisfy the seeded tests.
 */

import { all, fileContains } from "../checker.js";
import { compileCheck } from "../checkers/compile.js";
import { testCheck } from "../checkers/test.js";
import type { Evaluation } from "../evaluation.js";

const READ_TOOLS = ["fs.read", "code.read"] as const;
const WRITE_TOOLS = ["fs.write", "fs.edit", "code.write", "code.edit"] as const;

const SPEC = `
# Foundry text tool

Implement a small adapter-backed tool.

Requirements:
- Export \`createTextAdapter()\` from \`src/adapter.ts\`
- The adapter must expose tool \`text.uppercase\`
- Input: \`{ text: string }\`
- Output: \`{ uppercase: string }\`
- The handler must return the uppercase form of the input text
- Export \`service\` from \`src/service.ts\`
- \`src/service.ts\` must use \`defineAdapterService\` from \`@dpopsuev/alef-foundry\`
- Do not modify \`test/text-uppercase.test.ts\`
`.trim();

const PACKAGE_JSON = `
{
  "name": "foundry-text-tool-eval",
  "private": true,
  "type": "module"
}
`.trim();

const ADAPTER_STUB = `
export function createTextAdapter() {
  throw new Error("TODO");
}
`.trim();

const SERVICE_STUB = `
export const service = undefined as never;
`.trim();

const TEST_FILE = `
import { randomUUID } from "node:crypto";
import type { EventMessage } from "@dpopsuev/alef-kernel/bus";
import { InProcessBus } from "@dpopsuev/alef-kernel/bus";
import { describe, expect, it } from "vitest";
import { createTextAdapter } from "../src/adapter.js";
import { service } from "../src/service.js";

function commandCall(
  bus: InProcessBus,
  toolName: string,
  payload: Record<string, unknown>,
): Promise<EventMessage> {
  return new Promise((resolve, reject) => {
    const correlationId = randomUUID();
    const timer = setTimeout(() => reject(new Error(\`\${toolName} timed out\`)), 5_000);
    const off = bus.asBus().event.subscribe(toolName, (event) => {
      if (event.correlationId === correlationId) {
        clearTimeout(timer);
        off();
        resolve(event);
      }
    });
    bus.asBus().command.publish({ type: toolName, correlationId, payload });
  });
}

describe("text.uppercase", () => {
  it("uppercases input text over the command bus", async () => {
    const bus = new InProcessBus();
    const adapter = createTextAdapter();
    const unmount = adapter.mount(bus.asBus());
    try {
      const event = await commandCall(bus, "text.uppercase", { text: "Foundry" });
      expect(event.isError, event.errorMessage).toBe(false);
      expect(event.payload).toMatchObject({ uppercase: "FOUNDRY" });
    } finally {
      unmount();
    }
  });

  it("exports a Foundry-backed managed service", async () => {
    expect(service.name).toBe("text");
    expect(service.shareable).toBe(true);
    const managed = await service.create({ cwd: process.cwd() });
    expect(managed.adapters.map((adapter) => adapter.name)).toEqual(["text"]);
    expect(managed.tools.map((tool) => tool.name)).toContain("text.uppercase");
    await expect(managed.health()).resolves.toBe(true);
    await expect(managed.stop()).resolves.toBeUndefined();
  });
});
`.trim();

const FIXTURE_ADAPTER = `
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { z } from "zod";

const TEXT_UPPERCASE_TOOL = {
  name: "text.uppercase",
  description: "Convert input text to uppercase.",
  inputSchema: z.object({ text: z.string() }),
};

export function createTextAdapter() {
  return defineAdapter(
    "text",
    {
      command: {
        "text.uppercase": typedAction(TEXT_UPPERCASE_TOOL, async (ctx) => ({
          uppercase: ctx.payload.text.toUpperCase(),
        })),
      },
    },
    {
      description: "Uppercase text with a Foundry-backed service wrapper.",
      directives: ["Use text.uppercase when the caller needs uppercase text."],
    },
  );
}
`.trim();

const FIXTURE_SERVICE = `
import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createTextAdapter } from "./adapter.js";

export const service = defineAdapterService({
  name: "text",
  restart: "permanent",
  shareable: true,
  createAdapter() {
    return createTextAdapter();
  },
});
`.trim();

export const createFoundryTextTool: Evaluation = {
	id: "Foundry_CreateTextTool",
	toolLevel: "ReadWrite",
	template: "Write",
	kind: "capability",
	seed: [
		{ path: "SPEC.md", content: SPEC },
		{ path: "package.json", content: PACKAGE_JSON },
		{ path: "src/adapter.ts", content: ADAPTER_STUB },
		{ path: "src/service.ts", content: SERVICE_STUB },
		{ path: "test/text-uppercase.test.ts", content: TEST_FILE },
	],
	prompt:
		"Read SPEC.md and test/text-uppercase.test.ts. " +
		"Implement the Foundry-backed text tool by fixing src/adapter.ts and src/service.ts so the seeded tests pass. " +
		"Use defineAdapterService in src/service.ts and do not modify the test file.",
	expects: [
		{ tool: READ_TOOLS, target: { path: "SPEC.md" } },
		{ tool: READ_TOOLS, target: { path: "test/text-uppercase.test.ts" } },
		{ tool: WRITE_TOOLS, target: { path: "src/adapter.ts" } },
		{ tool: WRITE_TOOLS, target: { path: "src/service.ts" } },
	],
	checker: all(
		fileContains("src/adapter.ts", "defineAdapter(", "text.uppercase", "toUpperCase"),
		fileContains("src/service.ts", "defineAdapterService", "createTextAdapter"),
		compileCheck(),
		testCheck(),
	),
	fixture: {
		files: {
			"SPEC.md": SPEC,
			"package.json": PACKAGE_JSON,
			"src/adapter.ts": FIXTURE_ADAPTER,
			"src/service.ts": FIXTURE_SERVICE,
			"test/text-uppercase.test.ts": TEST_FILE,
		},
	},
	scenarioTimeoutMs: 300_000,
};
