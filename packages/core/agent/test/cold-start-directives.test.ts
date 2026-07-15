import { Directives } from "../src/directives.js";
import { createDefaultDirectives, registerAdapters } from "../src/prompt.js";
import { describe, expect, it } from "vitest";

describe("Directives.maxChars", { tags: ["unit"] }, () => {
	it("truncates resolved content and reports blockSizes", () => {
		const d = new Directives();
		d.register({
			id: "fat",
			priority: 1,
			content: "x".repeat(100),
			enabled: true,
			maxChars: 20,
		});
		const resolved = d.resolve();
		expect(resolved[0]!.content.length).toBeLessThan(100);
		expect(resolved[0]!.content).toContain("truncated");
		expect(d.blockSizes()[0]).toEqual({ id: "fat", chars: resolved[0]!.content.length });
	});
});

describe("createDefaultDirectives — cold-start budget", { tags: ["unit"] }, () => {
	it("tools block lists names without descriptions", () => {
		const prompt = createDefaultDirectives({
			tools: [{ name: "fs.read", description: "Read a very long description about files.", inputSchema: {} as never }],
			cwd: "/tmp",
		}).build();
		expect(prompt).toContain("- fs.read");
		expect(prompt).not.toContain("very long description");
	});

	it("core does not mandate parallel explore fan-out", () => {
		const prompt = createDefaultDirectives({ tools: [], cwd: "/tmp" }).build();
		expect(prompt).toContain("never pass inheritDirectives on explore");
		expect(prompt).not.toContain("Use parallel agent.run(explore) calls");
	});

	it("adapter directives are capped", () => {
		const d = createDefaultDirectives({ tools: [], cwd: "/tmp" });
		registerAdapters(d, [
			{
				name: "fat",
				tools: [],
				directives: ["Y".repeat(2_000)],
				subscriptions: { command: [], event: [], notification: [] },
				sources: [],
				mount: () => () => {},
			},
		]);
		const sizes = d.blockSizes();
		const adapter = sizes.find((b) => b.id === "adapter.fat");
		expect(adapter).toBeDefined();
		expect(adapter!.chars).toBeLessThanOrEqual(600 + 80); // header + truncation marker
	});
});
