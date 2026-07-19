import { describe, expect, it, vi } from "vitest";
import type { Args } from "../src/boot/args.js";
import { shouldMirrorSessionToRouter } from "../src/boot/build-delegation.js";
import { awaitProcessLifetime, SERVE_IDLE_TIMEOUT_MS } from "../src/boot/process-lifetime.js";
import { getRebootPort, setRebootPort } from "../src/boot/reboot-port.js";
import { setupSupervisorIpc } from "../src/boot/supervisor-ipc.js";
import { isHeadlessServe, ServeViewMode, selectViewMode } from "../src/boot/views.js";
import { parseUpdateArgs, runRestart, runUpdate, type UpdateShell } from "../src/client/commands/update-service.js";

function baseArgs(over: Partial<Args> = {}): Args {
	// Minimal stub — only fields read by isHeadlessServe / selectViewMode matter.
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

describe("parseUpdateArgs / runUpdate / runRestart", { tags: ["unit"] }, () => {
	function fakeShell(over: Partial<UpdateShell> = {}): UpdateShell {
		return {
			gitStatusPorcelain: () => "",
			gitPull: vi.fn(),
			gitCheckStatus: () => "up to date",
			npmInstall: vi.fn(),
			npmInstallGlobal: vi.fn(),
			build: vi.fn(),
			checkRelease: async () => null,
			...over,
		};
	}

	it("parses flags", () => {
		expect(parseUpdateArgs([])).toEqual({ force: false, checkOnly: false });
		expect(parseUpdateArgs(["--force", "--check"])).toEqual({ force: true, checkOnly: true });
	});

	it("aborts on dirty tree without --force", async () => {
		const result = await runUpdate({
			channel: "dev",
			force: false,
			checkOnly: false,
			version: "0.1.0",
			shell: fakeShell({ gitStatusPorcelain: () => " M file.ts" }),
			respawn: vi.fn(),
		});
		expect(result).toEqual({ kind: "aborted-dirty" });
	});

	it("force continues on dirty tree and prefers rebuild", async () => {
		const rebuild = vi.fn(async () => {});
		const respawn = vi.fn(async () => {});
		const shell = fakeShell({ gitStatusPorcelain: () => " M file.ts" });
		const result = await runUpdate({
			channel: "dev",
			force: true,
			checkOnly: false,
			version: "0.1.0",
			shell,
			rebuild,
			respawn,
		});
		expect(result).toEqual({ kind: "reloaded" });
		expect(shell.gitPull).toHaveBeenCalled();
		expect(shell.npmInstall).toHaveBeenCalled();
		expect(shell.build).toHaveBeenCalled();
		expect(rebuild).toHaveBeenCalled();
		expect(respawn).not.toHaveBeenCalled();
	});

	it("checkOnly returns git detail without mutating", async () => {
		const shell = fakeShell({ gitCheckStatus: () => "fetch would pull" });
		const result = await runUpdate({
			channel: "dev",
			force: false,
			checkOnly: true,
			version: "0.1.0",
			shell,
			respawn: vi.fn(),
		});
		expect(result).toEqual({ kind: "check", detail: "fetch would pull" });
		expect(shell.gitPull).not.toHaveBeenCalled();
	});

	it("stable checkOnly returns available release", async () => {
		const release = {
			version: "9.9.9",
			changelog: "notes",
			publishedAt: "t",
			htmlUrl: "u",
		};
		const result = await runUpdate({
			channel: "stable",
			force: false,
			checkOnly: true,
			version: "1.0.0",
			shell: fakeShell({ checkRelease: async () => release }),
			respawn: vi.fn(),
		});
		expect(result).toEqual({ kind: "available", release });
	});

	it("stable apply installs and respawns", async () => {
		const respawn = vi.fn(async () => {});
		const shell = fakeShell({
			checkRelease: async () => ({
				version: "2.0.0",
				changelog: "x",
				publishedAt: "t",
				htmlUrl: "u",
			}),
		});
		const result = await runUpdate({
			channel: "stable",
			force: false,
			checkOnly: false,
			version: "1.0.0",
			shell,
			respawn,
		});
		expect(result).toEqual({ kind: "respawn" });
		expect(shell.npmInstallGlobal).toHaveBeenCalledWith("@dpopsuev/alef@2.0.0");
		expect(respawn).toHaveBeenCalled();
	});

	it("runRestart prefers rebuild", async () => {
		const rebuild = vi.fn(async () => {});
		const respawn = vi.fn(async () => {});
		expect(await runRestart({ rebuild, respawn })).toEqual({ kind: "reloaded" });
		expect(rebuild).toHaveBeenCalled();
		expect(respawn).not.toHaveBeenCalled();
	});

	it("runRestart falls back to respawn", async () => {
		const respawn = vi.fn(async () => {});
		expect(await runRestart({ respawn })).toEqual({ kind: "respawn" });
		expect(respawn).toHaveBeenCalled();
	});
});
