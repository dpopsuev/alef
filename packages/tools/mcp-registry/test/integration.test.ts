import { BusFixture } from "@dpopsuev/alef-testkit/adapter";
import { describe, expect, it, vi } from "vitest";
import { createMcpRegistryAdapter } from "../src/adapter.js";

describe("MCP Registry Integration", () => {
	it("should search the MCP registry", async () => {
		const adapter = createMcpRegistryAdapter({ cwd: "/tmp" });
		const fixture = new BusFixture();
		fixture.mount(adapter);

		try {
			// Mock fetch for registry API
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					servers: [
						{
							server: {
								name: "io.github.test/filesystem",
								description: "Test filesystem server",
								version: "1.0.0",
								repository: {
									url: "https://github.com/test/filesystem",
									source: "github",
								},
								packages: [
									{
										registryType: "npm",
										identifier: "@test/filesystem",
										version: "1.0.0",
										transport: { type: "stdio" },
									},
								],
							},
							_meta: {
								"io.modelcontextprotocol.registry/official": {
									status: "active",
									publishedAt: "2025-01-01T00:00:00Z",
									updatedAt: "2025-01-01T00:00:00Z",
									isLatest: true,
								},
							},
						},
					],
					metadata: { count: 1 },
				}),
			} as Response);

			const result = await fixture.call("mcp.search", { query: "filesystem" });

			expect(result.payload).toMatchObject({
				query: "filesystem",
				count: 1,
				servers: expect.arrayContaining([
					expect.objectContaining({
						name: "io.github.test/filesystem",
						description: "Test filesystem server",
						version: "1.0.0",
					}),
				]),
			});

			expect(result.payload._display).toBeDefined();
		} finally {
			fixture.dispose();
		}
	});

	it("should list loaded MCP adapters", async () => {
		const adapter = createMcpRegistryAdapter({ cwd: "/tmp" });
		const fixture = new BusFixture();
		fixture.mount(adapter);

		try {
			const result = await fixture.call("mcp.list", {});

			expect(result.payload).toMatchObject({
				count: 0,
				adapters: [],
			});

			expect(result.payload._display).toBeDefined();
		} finally {
			fixture.dispose();
		}
	});

	it("should handle search errors gracefully", async () => {
		const adapter = createMcpRegistryAdapter({ cwd: "/tmp" });
		const fixture = new BusFixture();
		fixture.mount(adapter);

		try {
			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
			} as Response);

			const result = await fixture.call("mcp.search", { query: "test" });

			expect(result.payload.error).toBeDefined();
			expect(result.payload._display).toBeDefined();
		} finally {
			fixture.dispose();
		}
	});
});
