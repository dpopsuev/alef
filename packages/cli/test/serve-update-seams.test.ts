import { describe, expect, it, vi } from "vitest";
import type { Args } from "../src/boot/args.js";
import { shouldMirrorSessionToRouter } from "../src/boot/build-delegation.js";
import { awaitProcessLifetime, SERVE_IDLE_TIMEOUT_MS } from "../src/boot/process-lifetime.js";
import { getRebootPort, setRebootPort } from "../src/boot/reboot-port.js";
import { setupSupervisorIpc } from "../src/boot/supervisor-ipc.js";
import { isHeadlessServe, ServeViewMode, selectViewMode } from "../src/boot/views.js";
import {
	type GitOps,
	type PackageInstaller,
	parseUpdateArgs,
	type ReleaseChecker,
	runDevUpdate,
	runStableUpdate,
} from "../src/client/commands/update-service.js";

function baseArgs(over: Partial<Args> = {}): Args {
	return { print: false, noTui: false, serve: undefined, json: false, ...over } as Args;
}

describe("isHeadlessServe / selectViewMode", { tags: ["unit"] }, () => {
	it("selects ServeViewMode for --serve --no-tui", () => {
		const args = baseArgs({ serve: 0, noTui: true });
		expect(isHeadlessServe(args, true)).toBe(true);
		expect(selectViewMode(args, { cwd: "/tmp", modelId: "m", sessionId: "s" })).toBeInstanceOf(ServeViewMode);
	});

	it("selects ServeViewMode when stdin is not a TTY", () => {
		const args = baseArgs({ serve: 0, noTui: false });
		expect(isHeadlessServe(args, false)).toBe(true);
	});

	it("does not treat print mode as headless serve", () => {
		expect(isHeadlessServe(baseArgs({ serve: 0, print: true, noTui: true }), true)).toBe(false);
	});

	it("ServeViewMode stop resolves run without disposing session", async () => {
		const dispose = vi.fn();
		const session = { dispose, subscribe: () => () => {} } as never;
		const viewer = new ServeViewMode();
		const running = viewer.run(session);
		viewer.stop();
		await running;
		expect(dispose).not.toHaveBeenCalled();
	});
});

describe("awaitProcessLifetime", { tags: ["unit"] }, () => {
	it("awaits done when not serving", async () => {
		let resolved = false;
		const done = Promise.resolve().then(() => {
			resolved = true;
		});
		await awaitProcessLifetime({ daemon: false, serve: false, done });
		expect(resolved).toBe(true);
	});

	it("resolves after idle timeout for ephemeral serve", async () => {
		const start = Date.now();
		await awaitProcessLifetime({ daemon: false, serve: true, idleTimeoutMs: 20 });
		expect(Date.now() - start).toBeGreaterThanOrEqual(15);
	});

	it("exports default idle constant", () => {
		expect(SERVE_IDLE_TIMEOUT_MS).toBe(5 * 60 * 1000);
	});
});

describe("RebootPort", { tags: ["unit"] }, () => {
	it("set/get/clear and mirrors globalThis", async () => {
		const reboot = vi.fn(async () => {});
		setRebootPort({ reboot });
		expect(getRebootPort()?.reboot).toBe(reboot);
		await (globalThis as { alefReboot?: () => Promise<void> }).alefReboot?.();
		expect(reboot).toHaveBeenCalledOnce();
		setRebootPort(undefined);
		expect(getRebootPort()).toBeUndefined();
		expect((globalThis as { alefReboot?: unknown }).alefReboot).toBeUndefined();
	});
});

describe("setupSupervisorIpc", { tags: ["unit"] }, () => {
	it("acks handoff_prepare only when ALEF_SUPERVISOR=1", () => {
		const prev = process.env.ALEF_SUPERVISOR;
		process.env.ALEF_SUPERVISOR = "1";
		const sent: unknown[] = [];
		const originalSend = process.send;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
		(process as any).send = (msg: unknown) => {
			sent.push(msg);
			return true;
		};

		setupSupervisorIpc();
		process.emit("message", { type: "unknown" }, undefined as never);
		process.emit("message", { type: "handoff_prepare", envelope: { updateId: "u1" } }, undefined as never);

		expect(sent).toEqual([{ type: "handoff_ack", updateId: "u1" }]);

		if (prev === undefined) delete process.env.ALEF_SUPERVISOR;
		else process.env.ALEF_SUPERVISOR = prev;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore
		(process as any).send = originalSend;
		setRebootPort(undefined);
	});
});

describe("shouldMirrorSessionToRouter", { tags: ["unit"] }, () => {
	it("mirrors for serve or daemon", () => {
		expect(shouldMirrorSessionToRouter({ daemon: false, serve: 0 })).toBe(true);
		expect(shouldMirrorSessionToRouter({ daemon: true, serve: undefined })).toBe(true);
		expect(shouldMirrorSessionToRouter({ daemon: false, serve: undefined })).toBe(false);
	});
});

describe("parseUpdateArgs", { tags: ["unit"] }, () => {
	it("parses flags", () => {
		expect(parseUpdateArgs([])).toEqual({ pull: false, force: false, checkOnly: false });
		expect(parseUpdateArgs(["--force", "--check"])).toEqual({ pull: false, force: true, checkOnly: true });
		expect(parseUpdateArgs(["--pull"])).toEqual({ pull: true, force: false, checkOnly: false });
	});
});

describe("runDevUpdate", { tags: ["unit"] }, () => {
	function fakeGit(over: Partial<GitOps> = {}): GitOps {
		return {
			statusPorcelain: () => "",
			pull: vi.fn(),
			checkStatus: () => "up to date",
			installDeps: vi.fn(),
			...over,
		};
	}

	it("builds locally and prefers rebuild (no --pull)", async () => {
		const rebuild = vi.fn(async () => {});
		const respawn = vi.fn(async () => {});
		const git = fakeGit();
		const result = await runDevUpdate({ pull: false, force: false, checkOnly: false, git, rebuild, respawn });
		expect(result).toEqual({ kind: "rebuilt" });
		expect(git.pull).not.toHaveBeenCalled();
		expect(git.installDeps).not.toHaveBeenCalled();
		expect(rebuild).toHaveBeenCalled();
		expect(respawn).not.toHaveBeenCalled();
	});

	it("with --pull does git pull + installDeps before build", async () => {
		const rebuild = vi.fn(async () => {});
		const git = fakeGit();
		const result = await runDevUpdate({ pull: true, force: false, checkOnly: false, git, rebuild, respawn: vi.fn() });
		expect(result).toEqual({ kind: "rebuilt" });
		expect(git.pull).toHaveBeenCalled();
		expect(git.installDeps).toHaveBeenCalled();
	});

	it("--pull aborts on dirty tree without --force", async () => {
		const git = fakeGit({ statusPorcelain: () => " M file.ts" });
		const result = await runDevUpdate({ pull: true, force: false, checkOnly: false, git, respawn: vi.fn() });
		expect(result).toEqual({ kind: "aborted-dirty" });
	});

	it("--pull --force continues on dirty tree", async () => {
		const rebuild = vi.fn(async () => {});
		const git = fakeGit({ statusPorcelain: () => " M file.ts" });
		const result = await runDevUpdate({ pull: true, force: true, checkOnly: false, git, rebuild, respawn: vi.fn() });
		expect(result).toEqual({ kind: "rebuilt" });
		expect(git.pull).toHaveBeenCalled();
	});

	it("--check returns git detail without mutating", async () => {
		const git = fakeGit({ checkStatus: () => "fetch would pull" });
		const result = await runDevUpdate({ pull: false, force: false, checkOnly: true, git, respawn: vi.fn() });
		expect(result).toEqual({ kind: "check", detail: "fetch would pull" });
		expect(git.pull).not.toHaveBeenCalled();
	});
});

describe("runStableUpdate", { tags: ["unit"] }, () => {
	function fakeReleases(over: Partial<ReleaseChecker> = {}): ReleaseChecker {
		return { check: async () => null, ...over };
	}

	function fakePkgs(over: Partial<PackageInstaller> = {}): PackageInstaller {
		return { installGlobal: vi.fn(), ...over };
	}

	it("--check returns available release", async () => {
		const release = { version: "9.9.9", changelog: "notes", publishedAt: "t", htmlUrl: "u" };
		const result = await runStableUpdate({
			checkOnly: true,
			version: "1.0.0",
			releases: fakeReleases({ check: async () => release }),
			packages: fakePkgs(),
			respawn: vi.fn(),
		});
		expect(result).toEqual({ kind: "available", release });
	});

	it("installs and respawns on available release", async () => {
		const respawn = vi.fn(async () => {});
		const packages = fakePkgs();
		const result = await runStableUpdate({
			checkOnly: false,
			version: "1.0.0",
			releases: fakeReleases({
				check: async () => ({ version: "2.0.0", changelog: "x", publishedAt: "t", htmlUrl: "u" }),
			}),
			packages,
			respawn,
		});
		expect(result).toEqual({ kind: "respawn" });
		expect(packages.installGlobal).toHaveBeenCalledWith("@dpopsuev/alef@2.0.0");
		expect(respawn).toHaveBeenCalled();
	});

	it("returns up-to-date when no release", async () => {
		const result = await runStableUpdate({
			checkOnly: false,
			version: "1.0.0",
			releases: fakeReleases(),
			packages: fakePkgs(),
			respawn: vi.fn(),
		});
		expect(result).toEqual({ kind: "up-to-date" });
	});
});
