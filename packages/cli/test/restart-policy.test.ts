/**
 * Restart policy tests -- verifies correct scope selection and execution.
 */

import { describe, expect, it, vi } from "vitest";
import { applyRestartPolicy, type RestartExecutor } from "../src/boot/restart-policy.js";
import type { Sbom, SbomComponent } from "../src/boot/sbom.js";

function makeSbom(components: SbomComponent[]): Sbom {
	return { version: 1, generatedAt: "", gitHash: "abc", components };
}

function comp(name: string, scope: SbomComponent["scope"], hash: string): SbomComponent {
	return { name, scope, hash, files: 1 };
}

function stubExecutor(): RestartExecutor & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		exit: vi.fn(async () => {
			calls.push("exit");
			return undefined as never;
		}),
		restartTui: vi.fn(async () => {
			calls.push("restartTui");
		}),
		restartSupervisor: vi.fn(async () => {
			calls.push("restartSupervisor");
		}),
		reloadAdapters: vi.fn(async (names: string[]) => {
			calls.push(`reloadAdapters:${names.join(",")}`);
		}),
	};
}

describe("applyRestartPolicy", { tags: ["unit"] }, () => {
	it("does nothing when SBOMs are identical", async () => {
		const sbom = makeSbom([comp("tui", "tui", "aaa")]);
		const exec = stubExecutor();
		const result = await applyRestartPolicy(sbom, sbom, exec);
		expect(result.scope).toBe("none");
		expect(result.executed).toBe(false);
		expect(exec.calls).toHaveLength(0);
	});

	it("calls exit for bootstrapper changes", async () => {
		const old = makeSbom([comp("bootstrapper", "exit", "aaa")]);
		const next = makeSbom([comp("bootstrapper", "exit", "bbb")]);
		const exec = stubExecutor();
		await applyRestartPolicy(old, next, exec);
		expect(exec.exit).toHaveBeenCalled();
	});

	it("calls restartTui for TUI changes", async () => {
		const old = makeSbom([comp("tui", "tui", "aaa")]);
		const next = makeSbom([comp("tui", "tui", "bbb")]);
		const exec = stubExecutor();
		const result = await applyRestartPolicy(old, next, exec);
		expect(result.scope).toBe("tui");
		expect(exec.restartTui).toHaveBeenCalled();
	});

	it("calls restartSupervisor for supervisor changes", async () => {
		const old = makeSbom([comp("supervisor", "supervisor", "aaa")]);
		const next = makeSbom([comp("supervisor", "supervisor", "bbb")]);
		const exec = stubExecutor();
		const result = await applyRestartPolicy(old, next, exec);
		expect(result.scope).toBe("supervisor");
		expect(exec.restartSupervisor).toHaveBeenCalled();
	});

	it("calls reloadAdapters with changed adapter names", async () => {
		const old = makeSbom([comp("adapter:fs", "adapter", "aaa"), comp("adapter:shell", "adapter", "bbb")]);
		const next = makeSbom([comp("adapter:fs", "adapter", "xxx"), comp("adapter:shell", "adapter", "bbb")]);
		const exec = stubExecutor();
		const result = await applyRestartPolicy(old, next, exec);
		expect(result.scope).toBe("adapter");
		expect(exec.reloadAdapters).toHaveBeenCalledWith(["fs"]);
	});

	it("prefers exit over adapter when both change", async () => {
		const old = makeSbom([comp("core:kernel", "exit", "aaa"), comp("adapter:fs", "adapter", "bbb")]);
		const next = makeSbom([comp("core:kernel", "exit", "xxx"), comp("adapter:fs", "adapter", "yyy")]);
		const exec = stubExecutor();
		const result = await applyRestartPolicy(old, next, exec);
		expect(result.scope).toBe("exit");
		expect(exec.exit).toHaveBeenCalled();
		expect(exec.reloadAdapters).not.toHaveBeenCalled();
	});

	it("returns the diff in the result", async () => {
		const old = makeSbom([comp("tui", "tui", "aaa")]);
		const next = makeSbom([comp("tui", "tui", "bbb")]);
		const exec = stubExecutor();
		const result = await applyRestartPolicy(old, next, exec);
		expect(result.diff.changed).toHaveLength(1);
		expect(result.diff.changed[0]!.name).toBe("tui");
	});
});
