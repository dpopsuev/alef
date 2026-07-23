/**
 * Regression tests for boot-tui.ts's two Tier-1 fixes:
 *   1. WireSessionDeps is built once (buildWireSessionDeps) and is complete
 *      on every wire -- the initial cold boot AND every warm restartTui().
 *   2. The session is assembled exactly once, via the Foundry "session"
 *      service, not duplicated by a second direct call.
 *
 * The whole module graph boot-tui.ts touches is mocked; this is an
 * integration test of bootWithBootstrapper's calling convention, not of
 * the mocked-out modules themselves (those have their own test coverage).
 */

import { describe, expect, it, vi } from "vitest";
import { bootWithBootstrapper, type TuiBootDeps } from "../src/boot/boot-tui.js";
import type { CliFoundryRuntime } from "../src/boot/foundry-runtime.js";
import type { TuiShell, WireSessionDeps } from "../src/client/boot-types.js";

vi.mock("@dpopsuev/alef-agent/model", () => ({
	resolveStartupModel: () => ({ id: "test-model", contextWindow: 128000, reasoning: false }),
}));
vi.mock("@dpopsuev/alef-kernel/log", () => ({
	initSessionSink: () => {},
	traceEvent: () => {},
}));
vi.mock("@dpopsuev/alef-supervisor/environment", () => ({
	detectEnvironment: () => ({ mode: "local", canWarmReboot: false, buildCommand: undefined }),
}));
vi.mock("is-term-dark", () => ({ isTermDark: async () => true }));
vi.mock("../src/client/blueprint-picker-app.js", () => ({ pickBlueprintInTui: vi.fn() }));
vi.mock("../src/client/session-picker-app.js", () => ({ pickSessionInTui: vi.fn() }));
vi.mock("../src/client/theme.js", () => ({
	loadTheme: () => {},
	queryPalette: async () => ({}),
	TERMINAL_PALETTE_SLOTS: [],
}));
vi.mock("../src/boot/adapters.js", () => ({
	loadAdapters: async () => ({
		adapters: [],
		blueprintModelId: undefined,
		blueprintName: "test-blueprint",
		blueprintSurfaces: [],
		blueprintUpgradePolicy: "rebuild_only",
		blueprintPath: undefined,
		writableRoots: undefined,
	}),
}));
vi.mock("../src/boot/blueprints.js", () => ({ discoverBlueprints: () => [] }));
vi.mock("../src/boot/build-info.js", () => ({
	BUILD_INFO: { version: "0.0.0-test", gitHash: "test", gitBranch: "test", channel: "dev" },
}));
vi.mock("../src/boot/config.js", () => ({ getConfig: () => ({}) }));
vi.mock("../src/boot/discussion.js", () => ({ deriveDiscussionRef: () => undefined }));
vi.mock("../src/boot/reboot-port.js", () => ({
	getRebootPort: () => undefined,
	getRestartStrategy: () => undefined,
	setRebootPort: () => {},
}));
vi.mock("../src/boot/session.js", () => ({
	buildIdentityContext: () => ({
		humanActor: { address: "@you", hex: "#fff" },
		agentActor: { address: "@alef", hex: "#000" },
		actorRoutes: {},
	}),
	getUiSignalHandlers: () => new Map(),
	isCompacted: () => false,
}));

const shells: ReturnType<typeof stubShell>[] = [];

vi.mock("../src/client/tui-shell.js", () => ({
	bootTuiShell: vi.fn(() => {
		const shell = stubShell();
		shells.push(shell);
		return shell;
	}),
	wireSession: vi.fn(),
}));

const FAKE_SESSION = {
	getModel: () => "test-model",
	setModel: vi.fn(),
	getThinking: () => "off",
	setThinking: vi.fn(),
	unloadAdapter: vi.fn(() => true),
} as const;

/** Minimal SessionService-shaped object the fake runtime hands back from get("session"). */
function fakeSessionService() {
	return {
		session: FAKE_SESSION,
		resolvedModelDisplay: "test-model",
		humanAddress: "@you",
		agentAddress: "@alef",
		blueprintName: "test-blueprint",
		blueprintPath: undefined,
		setupSurface: async () => undefined,
		stop: async () => {},
		health: async () => true,
	};
}

function stubShell(): TuiShell & { resolveStop(): void } {
	let resolveStop: () => void = () => {};
	const stopped = new Promise<void>((r) => {
		resolveStop = r;
	});
	return {
		resolveStop,
		tui: { stop: vi.fn() } as unknown as TuiShell["tui"],
		t: {} as TuiShell["t"],
		output: {} as TuiShell["output"],
		input: {} as TuiShell["input"],
		footer: {} as TuiShell["footer"],
		writer: {} as TuiShell["writer"],
		editor: {} as TuiShell["editor"],
		chrome: {} as TuiShell["chrome"],
		tuiStore: {} as TuiShell["tuiStore"],
		cwd: "/test",
		handleBootEvent: () => {},
		stopped,
	};
}

function fakeStorage() {
	return {
		sessionPreview: () => ({}),
		sessions: {
			list: async () => [],
			listAll: async () => [],
			create: async () => ({ id: "s1", path: "/test/s1.jsonl" }),
			resume: async () => ({ id: "s1", path: "/test/s1.jsonl" }),
		},
	};
}

/** Build a fake CliFoundryRuntime that only starts serving get("session") after start() runs. */
function fakeRuntime() {
	let started = false;
	const get = vi.fn((name: string) => (name === "session" && started ? fakeSessionService() : undefined));
	return {
		foundry: { get } as unknown as CliFoundryRuntime["foundry"],
		resolveService: vi.fn(),
		get,
		start: vi.fn(async () => {
			started = true;
		}),
		stop: vi.fn(async () => {
			started = false;
		}),
		swap: vi.fn(),
		getStorage: vi.fn(),
		registerBuildService: vi.fn(),
		registerApplicationServices: vi.fn(),
	} as unknown as CliFoundryRuntime & { registerApplicationServices: ReturnType<typeof vi.fn> };
}

function expectCompleteDeps(deps: WireSessionDeps): void {
	expect(deps.signalHandlers).toBeDefined();
	expect(deps.isCompacted).toBeInstanceOf(Function);
	expect(deps.checkForUpdate).toBeInstanceOf(Function);
	expect(deps.restartTui).toBeInstanceOf(Function);
	expect(deps.restartSupervisor).toBeInstanceOf(Function);
	expect(deps.reloadAdapters).toBeInstanceOf(Function);
	expect(deps.buildInfo).toBeDefined();
	expect(deps.getConfig).toBeInstanceOf(Function);
}

describe("bootWithBootstrapper", { tags: ["unit"] }, () => {
	it("assembles the session exactly once, via the Foundry session service, with complete deps on every wire", async () => {
		shells.length = 0;
		const { bootTuiShell, wireSession } = await import("../src/client/tui-shell.js");
		vi.mocked(bootTuiShell).mockClear();
		vi.mocked(wireSession).mockClear();

		const runtime = fakeRuntime();
		const deps: TuiBootDeps = {
			args: { cwd: "/test", modelId: undefined } as TuiBootDeps["args"],
			cfg: {} as TuiBootDeps["cfg"],
			log: { warn: () => {}, info: () => {}, error: () => {} } as unknown as TuiBootDeps["log"],
			runtime,
			storage: fakeStorage() as unknown as TuiBootDeps["storage"],
		};

		const donePromise = bootWithBootstrapper(deps);

		await vi.waitFor(() => expect(wireSession).toHaveBeenCalledTimes(1));

		// registerApplicationServices must ask Foundry to skip its own "tui" service --
		// this Bootstrapper already owns TUI presentation directly.
		expect(runtime.registerApplicationServices).toHaveBeenCalledWith(expect.objectContaining({ registerTui: false }));
		// The session must come from Foundry (get("session")), only reachable after start().
		expect(runtime.start).toHaveBeenCalled();
		expect(runtime.get).toHaveBeenCalledWith("session");

		const [, firstResolved, firstDeps] = vi.mocked(wireSession).mock.calls[0] as [
			unknown,
			{ session: unknown; humanAddress: string; agentAddress: string },
			WireSessionDeps,
		];
		expect(firstResolved.session).toBe(FAKE_SESSION);
		expect(firstResolved.humanAddress).toBe("@you");
		expectCompleteDeps(firstDeps);

		// Trigger a warm TUI-only restart via the deps captured above, and confirm
		// the *rewired* shell also gets the complete deps set -- this is the bug
		// (restartTui's hand-built wireDeps was missing restartSupervisor/reloadAdapters).
		await firstDeps.restartTui!();
		expect(bootTuiShell).toHaveBeenCalledTimes(2);
		expect(wireSession).toHaveBeenCalledTimes(2);

		const [, secondResolved, secondDeps] = vi.mocked(wireSession).mock.calls[1] as [
			unknown,
			unknown,
			WireSessionDeps,
		];
		expect(secondResolved).toBe(firstResolved);
		expectCompleteDeps(secondDeps);

		// Unblock the boot sequence so the test doesn't hang.
		shells[0]!.resolveStop();
		await donePromise;
	});
});
