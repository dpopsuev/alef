/**
 * McpOrgan tests — mock MCP client, no real subprocess or network.
 *
 * Tests: tool discovery, tool naming, Motor routing, Sense publishing,
 *        error handling, unmount closes client.
 */

import { describe, expect, it, vi } from "vitest";
import { InProcessNerve } from "../src/buses.js";
import { createMcpOrganFromClient, McpOrgan } from "../src/mcp-organ.js";

// ---------------------------------------------------------------------------
// Mock MCPClient factory
// ---------------------------------------------------------------------------

type FakeToolMap = Record<
	string,
	{
		description: string;
		inputSchema?: Record<string, unknown>;
		execute: (args: unknown, opts: unknown) => Promise<unknown>;
	}
>;

function mockClient(toolDefs: FakeToolMap) {
	return {
		tools: vi.fn().mockResolvedValue(
			Object.fromEntries(
				Object.entries(toolDefs).map(([name, def]) => [
					name,
					{
						description: def.description,
						inputSchema: def.inputSchema ?? { type: "object", properties: {} },
						execute: def.execute,
					},
				]),
			),
		),
		close: vi.fn().mockResolvedValue(undefined),
	};
}

// ---------------------------------------------------------------------------
// Tool discovery
// ---------------------------------------------------------------------------

describe("McpOrgan — tool discovery", () => {
	it("exposes discovered MCP tools as organ.tools[]", async () => {
		const client = mockClient({
			list_files: { description: "List files", execute: async () => [] },
			read_file: { description: "Read a file", execute: async () => "" },
		});

		const organ = await createMcpOrganFromClient(client as never, "fs");
		expect(organ.tools).toHaveLength(2);
		const names = organ.tools.map((t) => t.name);
		expect(names).toContain("fs.list_files");
		expect(names).toContain("fs.read_file");
	});

	it("organ name prefixes all tool names", async () => {
		const client = mockClient({
			create_issue: { description: "Create a GitHub issue", execute: async () => ({}) },
		});

		const organ = await createMcpOrganFromClient(client as never, "github");
		expect(organ.tools[0].name).toBe("github.create_issue");
	});

	it("tool description comes from MCP server metadata", async () => {
		const client = mockClient({
			search: { description: "Search the codebase", execute: async () => [] },
		});

		const organ = await createMcpOrganFromClient(client as never, "code");
		expect(organ.tools[0].description).toBe("Search the codebase");
	});

	it("subscriptions match discovered tool names", async () => {
		const client = mockClient({
			get: { description: "Get", execute: async () => null },
			put: { description: "Put", execute: async () => null },
		});

		const organ = await createMcpOrganFromClient(client as never, "store");
		expect(organ.subscriptions.motor).toContain("store.get");
		expect(organ.subscriptions.motor).toContain("store.put");
		expect(organ.subscriptions.sense).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Motor → MCP → Sense routing
// ---------------------------------------------------------------------------

describe("McpOrgan — Motor/Sense routing", () => {
	it("Motor event routes to MCP execute and publishes Sense result", async () => {
		const execute = vi.fn().mockResolvedValue({ files: ["a.ts", "b.ts"] });
		const client = mockClient({
			list_files: { description: "List files", execute },
		});

		const organ = await createMcpOrganFromClient(client as never, "fs");
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		const result = await new Promise<Record<string, unknown>>((resolve) => {
			nerve.asNerve().sense.subscribe("fs.list_files", (e) => {
				resolve(e.payload);
			});
			nerve.asNerve().motor.publish({
				type: "fs.list_files",
				payload: { path: "/workspace", toolCallId: "tc-1" },
				correlationId: "c-1",
				timestamp: Date.now(),
			});
		});

		expect(execute).toHaveBeenCalledOnce();
		expect(result.toolCallId).toBe("tc-1");
	});

	it("MCP tool error publishes isError=true Sense event", async () => {
		const client = mockClient({
			boom: {
				description: "Always fails",
				execute: async () => {
					throw new Error("MCP server error");
				},
			},
		});

		const organ = await createMcpOrganFromClient(client as never, "bad");
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		const senseEvent = await new Promise<{ isError: boolean; errorMessage?: string }>((resolve) => {
			nerve.asNerve().sense.subscribe("bad.boom", (e) => resolve(e));
			nerve.asNerve().motor.publish({
				type: "bad.boom",
				payload: { toolCallId: "tc-2" },
				correlationId: "c-2",
				timestamp: Date.now(),
			});
		});

		expect(senseEvent.isError).toBe(true);
		expect(senseEvent.errorMessage).toContain("MCP server error");
	});
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("McpOrgan — lifecycle", () => {
	it("unmount closes the MCP client", async () => {
		const client = mockClient({
			noop: { description: "No-op", execute: async () => null },
		});

		const organ = await createMcpOrganFromClient(client as never, "test");
		const nerve = new InProcessNerve();
		const unmount = organ.mount(nerve.asNerve());

		await unmount();
		expect(client.close).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// Static factories (smoke test — no real subprocess/network)
// ---------------------------------------------------------------------------

describe("McpOrgan — static factories", () => {
	it("exposes McpOrgan.stdio and McpOrgan.http", () => {
		expect(typeof McpOrgan.stdio).toBe("function");
		expect(typeof McpOrgan.http).toBe("function");
	});
});
