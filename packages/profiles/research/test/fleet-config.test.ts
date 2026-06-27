import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { Supervisor } from "@dpopsuev/alef-supervisor/supervisor";
import { describe, expect, it } from "vitest";

function stubServiceDescriptor(name: string, dependsOn?: string[]): ServiceDescriptor {
	return {
		name,
		restart: "permanent",
		shareable: true,
		dependsOn,
		create(_opts: ServiceCreateOpts): Promise<ManagedService> {
			return Promise.resolve({
				name,
				restart: "permanent" as const,
				adapters: [],
				tools: [],
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				health: () => Promise.resolve(true),
			});
		},
	};
}

describe("research agent fleet config", { tags: ["unit"] }, () => {
	it("services are not running before startAll", () => {
		const supervisor = new Supervisor();
		supervisor.register(stubServiceDescriptor("scribe"));
		supervisor.register(stubServiceDescriptor("locus", ["scribe"]));

		expect(supervisor.get("scribe")).toBeUndefined();
		expect(supervisor.get("locus")).toBeUndefined();
		expect(supervisor.names()).toHaveLength(0);
	});

	it("tools are empty before start", () => {
		const supervisor = new Supervisor();
		supervisor.register(stubServiceDescriptor("scribe"));
		expect(supervisor.tools()).toHaveLength(0);
	});

	it("dependency ordering is preserved", async () => {
		const bootOrder: string[] = [];
		function trackingDescriptor(name: string, dependsOn?: string[]): ServiceDescriptor {
			return {
				...stubServiceDescriptor(name, dependsOn),
				create(_opts: ServiceCreateOpts): Promise<ManagedService> {
					bootOrder.push(name);
					return stubServiceDescriptor(name).create(_opts);
				},
			};
		}

		const supervisor = new Supervisor();
		supervisor.register(trackingDescriptor("locus", ["scribe"]));
		supervisor.register(trackingDescriptor("scribe"));

		await supervisor.startAll({ cwd: "/tmp" });

		expect(bootOrder).toEqual(["scribe", "locus"]);
		await supervisor.stopAll();
	});

	it("rejects circular dependencies", async () => {
		const supervisor = new Supervisor();
		supervisor.register(stubServiceDescriptor("a", ["b"]));
		supervisor.register(stubServiceDescriptor("b", ["a"]));

		await expect(supervisor.startAll({ cwd: "/tmp" })).rejects.toThrow("Circular dependency");
	});
});
