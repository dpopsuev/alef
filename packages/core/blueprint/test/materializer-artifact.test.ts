import { describe, expect, it } from "vitest";
import { resolvePackageIdentity } from "../src/materializer.js";
import type { CompiledAgentDefinition } from "../src/types.js";

type AdapterDef = CompiledAgentDefinition["adapters"][number];

function adapterDef(overrides: Partial<AdapterDef>): AdapterDef {
	return { name: "_external", actions: [], toolNames: [], ...overrides };
}

describe("resolvePackageIdentity", () => {
	it("resolves a built-in adapter alias to its real package name and version", () => {
		const identity = resolvePackageIdentity(adapterDef({ name: "fs" }));
		expect(identity.adapter).toBe("fs");
		expect(identity.package).toBe("@dpopsuev/alef-tool-fs");
		expect(identity.vendor).toBe("dpopsuev");
		expect(identity.version).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("passes an already-scoped package name through unresolved", () => {
		const identity = resolvePackageIdentity(adapterDef({ name: "@dpopsuev/alef-tool-shell" }));
		expect(identity.package).toBe("@dpopsuev/alef-tool-shell");
		expect(identity.vendor).toBe("dpopsuev");
	});

	it("treats path-loaded adapters as local, not npm-identified", () => {
		const identity = resolvePackageIdentity(adapterDef({ name: "_external", path: "/tmp/my-adapter.ts" }));
		expect(identity.package).toBe("_external");
		expect(identity.version).toBe("local");
		expect(identity.vendor).toBe("local");
	});

	it("falls back to 'unknown' version for an unresolvable package", () => {
		const identity = resolvePackageIdentity(adapterDef({ name: "definitely-not-a-real-adapter-xyz" }));
		expect(identity.version).toBe("unknown");
	});
});
