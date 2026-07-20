/**
 * Integration test: full Bootstrapper flow with stub session.
 *
 * Boots a real TUI shell (without a terminal), runs the Bootstrapper
 * with stubs, verifies the event sequence and that wireSession connects.
 */

import { describe, expect, it } from "vitest";
import { type BootstrapperConfig, createBootstrapper } from "../src/boot/bootstrapper.js";
import type {
	BootEvent,
	ResolvedSession,
	SessionSelection,
	TuiShell,
	WireSessionDeps,
} from "../src/client/boot-types.js";

function stubShell(): TuiShell & { bootEvents: BootEvent[]; resolve(): void } {
	const bootEvents: BootEvent[] = [];
	let resolveStop: () => void;
	const stopped = new Promise<void>((r) => {
		resolveStop = r;
	});
	return {
		bootEvents,
		resolve() {
			resolveStop();
		},
		tui: {} as TuiShell["tui"],
		t: {} as TuiShell["t"],
		output: {} as TuiShell["output"],
		input: {} as TuiShell["input"],
		footer: {} as TuiShell["footer"],
		writer: {} as TuiShell["writer"],
		editor: {} as TuiShell["editor"],
		chrome: {} as TuiShell["chrome"],
		tuiStore: {} as TuiShell["tuiStore"],
		cwd: "/test",
		handleBootEvent(event: BootEvent) {
			bootEvents.push(event);
		},
		stopped,
	};
}

function stubSelection(): SessionSelection {
	return { store: { id: "test-session" } as SessionSelection["store"], isNew: true };
}

function stubResolved(): ResolvedSession {
	return {
		session: {
			state: { id: "s1", modelId: "m1", contextWindow: 128000 },
			getModel: () => "m1",
			getThinking: () => "",
			subscribe: () => () => {},
		} as unknown as ResolvedSession["session"],
		store: { id: "test-session" } as ResolvedSession["store"],
		sessionId: "test-session",
		modelId: "test-model",
		contextWindow: 128000,
		isNew: true,
		getModel: () => "test-model",
		setModel: () => {},
		getThinking: () => "",
		setThinking: () => {},
		humanAddress: "@you",
		agentAddress: "@alef",
		blueprintName: "coding",
	};
}

describe("Bootstrapper integration", { tags: ["unit"] }, () => {
	it("full boot sequence emits events in order and calls wireSession", async () => {
		const shell = stubShell();
		const phases: string[] = [];
		let wired = false;
		let wiredDeps: WireSessionDeps | null = null;

		const config: BootstrapperConfig = {
			cwd: "/test",
			willUseTui: true,
			createShell: async () => shell,
			wireSession: (_s, _r, deps) => {
				wired = true;
				wiredDeps = deps;
			},
			pickSession: async () => stubSelection(),
			resolveSession: async () => stubResolved(),
			getDeps: () => ({
				signalHandlers: new Map(),
				isCompacted: () => false,
				checkForUpdate: async () => null,
				restartTui: async () => {},
				reloadAdapters: async () => {},
				restartSupervisor: async () => {},
			}),
		};

		const handle = createBootstrapper(config);
		handle.subscribe((e) => phases.push(`${e.phase}:${"status" in e ? e.status : e.error}`));
		setTimeout(() => shell.resolve(), 50);
		await handle.done;

		expect(wired).toBe(true);
		expect(wiredDeps).not.toBeNull();
		expect(wiredDeps!.restartTui).toBeDefined();
		expect(wiredDeps!.reloadAdapters).toBeDefined();
		expect(wiredDeps!.restartSupervisor).toBeDefined();

		expect(phases).toEqual([
			"session:picking",
			"session:ready",
			"adapters:loading",
			"adapters:ready",
			"model:ready",
			"agent:wiring",
			"agent:ready",
		]);

		expect(shell.bootEvents.length).toBe(7);
	});

	it("boot events are routed to shell.handleBootEvent", async () => {
		const shell = stubShell();

		const config: BootstrapperConfig = {
			cwd: "/test",
			willUseTui: true,
			createShell: async () => shell,
			wireSession: () => {},
			pickSession: async () => stubSelection(),
			resolveSession: async () => stubResolved(),
			getDeps: () => ({
				signalHandlers: new Map(),
				isCompacted: () => false,
				checkForUpdate: async () => null,
			}),
		};

		const handle = createBootstrapper(config);
		setTimeout(() => shell.resolve(), 50);
		await handle.done;

		const phaseNames = shell.bootEvents.map((e) => e.phase);
		expect(phaseNames).toContain("session");
		expect(phaseNames).toContain("agent");
		expect(phaseNames[phaseNames.length - 1]).toBe("agent");
	});

	it("error during resolveSession emits error event", async () => {
		const shell = stubShell();
		const events: BootEvent[] = [];

		const config: BootstrapperConfig = {
			cwd: "/test",
			willUseTui: true,
			createShell: async () => shell,
			wireSession: () => {},
			pickSession: async () => stubSelection(),
			resolveSession: async () => {
				throw new Error("adapter load failed");
			},
			getDeps: () => ({
				signalHandlers: new Map(),
				isCompacted: () => false,
				checkForUpdate: async () => null,
			}),
		};

		const handle = createBootstrapper(config);
		handle.subscribe((e) => events.push(e));

		await expect(handle.done).rejects.toThrow("adapter load failed");

		const errorEvent = events.find((e) => e.phase === "error");
		expect(errorEvent).toBeDefined();
		if (errorEvent?.phase === "error") {
			expect(errorEvent.error).toBe("adapter load failed");
		}

		// Error should also be routed to the shell
		const shellError = shell.bootEvents.find((e) => e.phase === "error");
		expect(shellError).toBeDefined();
	});
});
