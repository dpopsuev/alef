/**
 * SBOM diff logic tests.
 */

import { describe, expect, it } from "vitest";
import type { Sbom, SbomComponent } from "../src/boot/sbom.js";
import { diffSbom } from "../src/boot/sbom-diff.js";

function makeSbom(components: SbomComponent[]): Sbom {
	return { version: 1, generatedAt: "", gitHash: "abc", components };
}

function comp(name: string, scope: SbomComponent["scope"], hash: string): SbomComponent {
	return { name, scope, hash, files: 1 };
}

describe("diffSbom", { tags: ["unit"] }, () => {
	it("returns none when SBOMs are identical", () => {
		const sbom = makeSbom([comp("bootstrapper", "exit", "aaa"), comp("tui", "tui", "bbb")]);
		const result = diffSbom(sbom, sbom);
		expect(result.restartScope).toBe("none");
		expect(result.changed).toHaveLength(0);
		expect(result.added).toHaveLength(0);
		expect(result.removed).toHaveLength(0);
	});

	it("detects changed component and returns its scope", () => {
		const old = makeSbom([comp("tui", "tui", "aaa")]);
		const next = makeSbom([comp("tui", "tui", "bbb")]);
		const result = diffSbom(old, next);
		expect(result.restartScope).toBe("tui");
		expect(result.changed).toHaveLength(1);
		expect(result.changed[0]!.name).toBe("tui");
		expect(result.changed[0]!.oldHash).toBe("aaa");
		expect(result.changed[0]!.newHash).toBe("bbb");
	});

	it("highest scope wins when multiple components change", () => {
		const old = makeSbom([
			comp("adapter:fs", "adapter", "aaa"),
			comp("tui", "tui", "bbb"),
			comp("supervisor", "supervisor", "ccc"),
		]);
		const next = makeSbom([
			comp("adapter:fs", "adapter", "xxx"),
			comp("tui", "tui", "yyy"),
			comp("supervisor", "supervisor", "ccc"),
		]);
		const result = diffSbom(old, next);
		expect(result.restartScope).toBe("tui");
		expect(result.changed).toHaveLength(2);
	});

	it("exit scope wins over everything", () => {
		const old = makeSbom([comp("bootstrapper", "exit", "aaa"), comp("tui", "tui", "bbb")]);
		const next = makeSbom([comp("bootstrapper", "exit", "xxx"), comp("tui", "tui", "yyy")]);
		const result = diffSbom(old, next);
		expect(result.restartScope).toBe("exit");
	});

	it("adapter-only changes report adaptersToReload", () => {
		const old = makeSbom([
			comp("adapter:fs", "adapter", "aaa"),
			comp("adapter:shell", "adapter", "bbb"),
			comp("adapter:web", "adapter", "ccc"),
		]);
		const next = makeSbom([
			comp("adapter:fs", "adapter", "xxx"),
			comp("adapter:shell", "adapter", "bbb"),
			comp("adapter:web", "adapter", "yyy"),
		]);
		const result = diffSbom(old, next);
		expect(result.restartScope).toBe("adapter");
		expect(result.adaptersToReload).toEqual(["fs", "web"]);
	});

	it("adaptersToReload is empty when scope is higher than adapter", () => {
		const old = makeSbom([comp("adapter:fs", "adapter", "aaa"), comp("tui", "tui", "bbb")]);
		const next = makeSbom([comp("adapter:fs", "adapter", "xxx"), comp("tui", "tui", "yyy")]);
		const result = diffSbom(old, next);
		expect(result.restartScope).toBe("tui");
		expect(result.adaptersToReload).toHaveLength(0);
	});

	it("detects added components", () => {
		const old = makeSbom([comp("tui", "tui", "aaa")]);
		const next = makeSbom([comp("tui", "tui", "aaa"), comp("adapter:new", "adapter", "bbb")]);
		const result = diffSbom(old, next);
		expect(result.restartScope).toBe("adapter");
		expect(result.added).toHaveLength(1);
		expect(result.added[0]!.name).toBe("adapter:new");
	});

	it("detects removed components", () => {
		const old = makeSbom([comp("tui", "tui", "aaa"), comp("adapter:old", "adapter", "bbb")]);
		const next = makeSbom([comp("tui", "tui", "aaa")]);
		const result = diffSbom(old, next);
		expect(result.restartScope).toBe("adapter");
		expect(result.removed).toHaveLength(1);
		expect(result.removed[0]!.name).toBe("adapter:old");
	});

	it("handles empty SBOMs", () => {
		const empty = makeSbom([]);
		const result = diffSbom(empty, empty);
		expect(result.restartScope).toBe("none");
	});
});
