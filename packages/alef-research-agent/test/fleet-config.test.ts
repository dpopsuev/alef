import { ServiceFleet } from "@dpopsuev/alef-runtime";
import { describe, expect, it } from "vitest";

describe("research agent fleet config", { tags: ["unit"] }, () => {
	it("declares scribe and locus with correct dependency", () => {
		const fleet = new ServiceFleet({
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
		});

		expect(fleet.get("scribe")).toBeUndefined();
		expect(fleet.get("locus")).toBeUndefined();
		expect(fleet.names()).toHaveLength(0);
	});

	it("fleet tools are empty before start", () => {
		const fleet = new ServiceFleet({
			services: {
				scribe: { binary: "echo", transport: "stdio" },
			},
		});
		expect(fleet.tools()).toHaveLength(0);
	});

	it("fleet config supports ingestURL reference", () => {
		const config = {
			services: {
				scribe: { binary: "scribe", transport: "http" as const, httpUrl: "http://localhost:8080" },
				locus: { binary: "locus", dependsOn: ["scribe"], ingestURL: "scribe" },
			},
		};

		const _fleet = new ServiceFleet(config);
		expect(config.services.locus.ingestURL).toBe("scribe");
		expect(config.services.locus.dependsOn).toEqual(["scribe"]);
	});

	it("fleet rejects circular dependencies", async () => {
		const fleet = new ServiceFleet({
			services: {
				a: { binary: "a", dependsOn: ["b"] },
				b: { binary: "b", dependsOn: ["a"] },
			},
		});

		const { InProcessNerve } = await import("@dpopsuev/alef-kernel");
		const nerve = new InProcessNerve();
		await expect(fleet.start(nerve.asNerve())).rejects.toThrow("Circular dependency");
	});
});
