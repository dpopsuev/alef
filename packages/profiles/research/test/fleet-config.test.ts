import type { McpAdapterFactory } from "@dpopsuev/alef-supervisor/tool";
import { ToolSupervisor } from "@dpopsuev/alef-supervisor/tool";
import { describe, expect, it } from "vitest";

const stubMcp: McpAdapterFactory = {
	http: () => ({ name: "stub", tools: [], subscriptions: { command: [], event: [], notification: [] }, sources: [], mount: () => () => {}, invalidate() {} }),
	stdio: () => ({ name: "stub", tools: [], subscriptions: { command: [], event: [], notification: [] }, sources: [], mount: () => () => {}, invalidate() {} }),
};

describe("research agent fleet config", { tags: ["unit"] }, () => {
	it("declares scribe and locus with correct dependency", () => {
		const supervisor = new ToolSupervisor({
			services: {
				scribe: {
					binary: "/usr/bin/echo",
					args: ["scribe"],
					transport: "stdio",
					restart: "permanent",
				},
				locus: {
					binary: "/usr/bin/echo",
					args: ["locus"],
					transport: "stdio",
					restart: "permanent",
					dependsOn: ["scribe"],
					ingestURL: "scribe",
				},
			},
		}, stubMcp);

		expect(supervisor.get("scribe")).toBeUndefined();
		expect(supervisor.get("locus")).toBeUndefined();
		expect(supervisor.names()).toHaveLength(0);
	});

	it("fleet tools are empty before start", () => {
		const supervisor = new ToolSupervisor({
			services: {
				scribe: { binary: "echo", transport: "stdio" },
			},
		}, stubMcp);
		expect(supervisor.tools()).toHaveLength(0);
	});

	it("fleet config supports ingestURL reference", () => {
		const config = {
			services: {
				scribe: { binary: "scribe", transport: "http" as const, httpUrl: "http://localhost:8080" },
				locus: { binary: "locus", dependsOn: ["scribe"], ingestURL: "scribe" },
			},
		};

		const _fleet = new ToolSupervisor(config, stubMcp);
		expect(config.services.locus.ingestURL).toBe("scribe");
		expect(config.services.locus.dependsOn).toEqual(["scribe"]);
	});

	it("fleet rejects circular dependencies", async () => {
		const supervisor = new ToolSupervisor({
			services: {
				a: { binary: "a", dependsOn: ["b"] },
				b: { binary: "b", dependsOn: ["a"] },
			},
		}, stubMcp);

		const { InProcessBus } = await import("@dpopsuev/alef-kernel/bus");
		const nerve = new InProcessBus();
		await expect(supervisor.start(nerve.asBus())).rejects.toThrow("Circular dependency");
	});
});
