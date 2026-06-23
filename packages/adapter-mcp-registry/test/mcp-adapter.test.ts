/**
 * McpAdapter tests — mock MCP client, no real subprocess or network.
 *
 * Tests: tool discovery, tool naming, Command routing, Event publishing,
 * error handling, unmount closes client.
 */

import { InProcessBus } from "@dpopsuev/alef-kernel/bus";
import { describe, expect, it, vi } from "vitest";
import { createMcpAdapterFromClient, McpAdapter } from "../src/mcp-adapter.js";

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

describe("McpAdapter — tool discovery", { tags: ["unit"] }, () => {
	it("exposes discovered MCP tools as adapter.tools[]", async () => {
		const client = mockClient({
			list_files: { description: "List files", execute: async () => [] },
			read_file: { description: "Read a file", execute: async () => "" },
		});

		const adapter = await createMcpAdapterFromClient(client as never, "fs");
		expect(adapter.tools).toHaveLength(2);
		const names = adapter.tools.map((t) => t.name);
		expect(names).toContain("fs.list_files");
		expect(names).toContain("fs.read_file");
	});

	it("adapter name prefixes all tool names", async () => {
		const client = mockClient({
			create_issue: { description: "Create a GitHub issue", execute: async () => ({}) },
		});

		const adapter = await createMcpAdapterFromClient(client as never, "github");
		expect(adapter.tools[0].name).toBe("github.create_issue");
	});

	it("tool description comes from MCP server metadata", async () => {
		const client = mockClient({
			search: { description: "Search the codebase", execute: async () => [] },
		});

		const adapter = await createMcpAdapterFromClient(client as never, "code");
		expect(adapter.tools[0].description).toBe("Search the codebase");
	});

	it("subscriptions match discovered tool names", async () => {
		const client = mockClient({
			get: { description: "Get", execute: async () => null },
			put: { description: "Put", execute: async () => null },
		});

		const adapter = await createMcpAdapterFromClient(client as never, "store");
		expect(adapter.subscriptions.command).toContain("store.get");
		expect(adapter.subscriptions.command).toContain("store.put");
		expect(adapter.subscriptions.event).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Command → MCP → Event routing
// ---------------------------------------------------------------------------

describe("McpAdapter — Command/Event routing", { tags: ["unit"] }, () => {
	it("Command message routes to MCP execute and publishes Event result", async () => {
		const execute = vi.fn().mockResolvedValue({ files: ["a.ts", "b.ts"] });
		const client = mockClient({
			list_files: { description: "List files", execute },
		});

		const adapter = await createMcpAdapterFromClient(client as never, "fs");
		const nerve = new InProcessBus();
		adapter.mount(nerve.asBus());

		const result = await new Promise<Record<string, unknown>>((resolve) => {
			nerve.asBus().event.subscribe("fs.list_files", (e) => {
				resolve(e.payload);
			});
			nerve.asBus().command.publish({
				type: "fs.list_files",
				payload: { path: "/workspace", toolCallId: "tc-1" },
				correlationId: "c-1",
			});
		});

		expect(execute).toHaveBeenCalledOnce();
		expect(result.toolCallId).toBe("tc-1");
	});

	it("MCP tool error publishes isError=true Event message", async () => {
		const client = mockClient({
			boom: {
				description: "Always fails",
				execute: async () => {
					throw new Error("MCP server error");
				},
			},
		});

		const adapter = await createMcpAdapterFromClient(client as never, "bad");
		const nerve = new InProcessBus();
		adapter.mount(nerve.asBus());

		const eventMessage = await new Promise<{ isError: boolean; errorMessage?: string }>((resolve) => {
			nerve.asBus().event.subscribe("bad.boom", (e) => resolve(e));
			nerve.asBus().command.publish({
				type: "bad.boom",
				payload: { toolCallId: "tc-2" },
				correlationId: "c-2",
			});
		});

		expect(eventMessage.isError).toBe(true);
		expect(eventMessage.errorMessage).toContain("MCP server error");
	});
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("McpAdapter — lifecycle", { tags: ["unit"] }, () => {
	it("unmount closes the MCP client", async () => {
		const client = mockClient({
			noop: { description: "No-op", execute: async () => null },
		});

		const adapter = await createMcpAdapterFromClient(client as never, "test");
		const nerve = new InProcessBus();
		adapter.mount(nerve.asBus());

		await adapter.close?.();
		expect(client.close).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// Static factories (smoke test — no real subprocess/network)
// ---------------------------------------------------------------------------

describe("McpAdapter — static factories", { tags: ["unit"] }, () => {
	it("exposes McpAdapter.stdio and McpAdapter.http", () => {
		expect(typeof McpAdapter.stdio).toBe("function");
		expect(typeof McpAdapter.http).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// async MCP execute error handling (regression)
// ---------------------------------------------------------------------------

describe("async MCP execute error handling — regression ", { tags: ["unit"] }, () => {
	it("publishes isError event message when execute rejects after an async step", async () => {
		// Simulate a tool whose execute does real async work then throws.
		const client = mockClient({
			slow_fail: {
				description: "Fails after an async step",
				execute: async () => {
					// Yield to the event loop (simulates a real async operation like fetch).
					await new Promise((r) => setTimeout(r, 5));
					throw new Error("connection refused after async step");
				},
			},
		});

		const adapter = await createMcpAdapterFromClient(client as never, "net");
		const nerve = new InProcessBus();
		const n = nerve.asBus();
		adapter.mount(n);

		// Collect event messages published on the "net.slow_fail" channel.
		const eventMessages: import("@dpopsuev/alef-kernel").EventMessage[] = [];
		n.event.subscribe("net.slow_fail", (e) => {
			eventMessages.push(e);
		});

		// Trigger the tool call via command.
		n.command.publish({
			type: "net.slow_fail",
			payload: { toolCallId: "tc-async-throw" },
			correlationId: "corr-async-throw",
		});

		await new Promise((r) => setTimeout(r, 500));

		expect(eventMessages.length).toBeGreaterThan(0);
		expect(eventMessages[0]?.isError).toBe(true);
	});

	it("does not hang when execute rejects synchronously (control case)", async () => {
		const client = mockClient({
			sync_fail: {
				description: "Fails synchronously",
				execute: async () => {
					throw new Error("immediate failure");
				},
			},
		});

		const adapter = await createMcpAdapterFromClient(client as never, "net");
		const nerve = new InProcessBus();
		const n = nerve.asBus();
		adapter.mount(n);

		const eventMessages: import("@dpopsuev/alef-kernel").EventMessage[] = [];
		n.event.subscribe("net.sync_fail", (e) => {
			eventMessages.push(e);
		});
		n.command.publish({
			type: "net.sync_fail",
			payload: { toolCallId: "tc-sync-throw" },
			correlationId: "corr-sync-throw",
		});

		await new Promise((r) => setTimeout(r, 200));
		expect(eventMessages.length).toBeGreaterThan(0);
		expect(eventMessages[0]?.isError).toBe(true);
	});
});
