/**
 * Bootstrapper lifecycle event contract and boot sequence tests.
 *
 * Validates the BootEvent discriminated union, BootHandle pub/sub,
 * exhaustiveness of handleBootEvent, and the createBootstrapper
 * sequencing through stub factories.
 */

import { describe, expect, it } from "vitest";
import type { BootEvent, BootEventListener, BootHandle } from "../src/boot/bootstrapper.js";
import { type BootstrapperConfig, createBootstrapper } from "../src/boot/bootstrapper.js";
import type { ResolvedSession, SessionSelection, TuiShell } from "../src/client/boot-types.js";

/** Minimal BootHandle implementation for testing the pub/sub contract. */
function createTestHandle(): BootHandle & { emit(event: BootEvent): void; resolve(): void } {
	const listeners = new Set<BootEventListener>();
	let resolveDone: () => void;
	const done = new Promise<void>((r) => {
		resolveDone = r;
	});
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(event) {
			for (const listener of listeners) listener(event);
		},
		resolve() {
			resolveDone();
		},
		done,
	};
}

/** Minimal TuiShell stub for testing the boot sequence. */
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

/** Minimal SessionSelection stub. */
function stubSelection(): SessionSelection {
	return { store: { id: "test-session" } as SessionSelection["store"], isNew: true };
}

/** Minimal ResolvedSession stub. */
function stubResolved(): ResolvedSession {
	return {
		session: {} as ResolvedSession["session"],
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

// ---------------------------------------------------------------------------
// BootEvent contract tests
// ---------------------------------------------------------------------------

describe("BootEvent discriminated union", { tags: ["unit"] }, () => {
	it("every phase/status combination is distinguishable", () => {
		const events: BootEvent[] = [
			{ phase: "storage", status: "starting" },
			{ phase: "storage", status: "ready" },
			{ phase: "session", status: "picking" },
			{ phase: "session", status: "ready", sessionId: "s1", isNew: true },
			{ phase: "adapters", status: "loading" },
			{ phase: "adapters", status: "ready", adapterCount: 5, blueprintName: "coding" },
			{ phase: "model", status: "ready", modelId: "claude-sonnet-4-5" },
			{ phase: "agent", status: "wiring" },
			{ phase: "agent", status: "ready" },
			{ phase: "error", error: "storage init failed" },
		];

		const keys = events.map((e) => `${e.phase}:${"status" in e ? e.status : e.error}`);
		expect(new Set(keys).size).toBe(events.length);
	});

	it("narrowing works on phase field", () => {
		const event: BootEvent = { phase: "session", status: "ready", sessionId: "abc", isNew: false };
		if (event.phase === "session" && event.status === "ready") {
			expect(event.sessionId).toBe("abc");
			expect(event.isNew).toBe(false);
		}
	});

	it("narrowing works on error phase", () => {
		const event: BootEvent = { phase: "error", error: "boom" };
		if (event.phase === "error") {
			expect(event.error).toBe("boom");
		}
	});
});

// ---------------------------------------------------------------------------
// BootHandle pub/sub tests
// ---------------------------------------------------------------------------

describe("BootHandle pub/sub", { tags: ["unit"] }, () => {
	it("delivers events to subscribers", () => {
		const handle = createTestHandle();
		const received: BootEvent[] = [];
		handle.subscribe((e) => received.push(e));

		handle.emit({ phase: "storage", status: "starting" });
		handle.emit({ phase: "storage", status: "ready" });

		expect(received).toHaveLength(2);
		expect(received[0]).toEqual({ phase: "storage", status: "starting" });
		expect(received[1]).toEqual({ phase: "storage", status: "ready" });
	});

	it("unsubscribe stops delivery", () => {
		const handle = createTestHandle();
		const received: BootEvent[] = [];
		const unsub = handle.subscribe((e) => received.push(e));

		handle.emit({ phase: "storage", status: "starting" });
		unsub();
		handle.emit({ phase: "storage", status: "ready" });

		expect(received).toHaveLength(1);
	});

	it("multiple subscribers each receive all events", () => {
		const handle = createTestHandle();
		const a: BootEvent[] = [];
		const b: BootEvent[] = [];
		handle.subscribe((e) => a.push(e));
		handle.subscribe((e) => b.push(e));

		handle.emit({ phase: "agent", status: "ready" });

		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);
	});

	it("done resolves when boot completes", async () => {
		const handle = createTestHandle();
		let resolved = false;
		void handle.done.then(() => {
			resolved = true;
		});

		expect(resolved).toBe(false);
		handle.resolve();
		await handle.done;
		expect(resolved).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Exhaustiveness check
// ---------------------------------------------------------------------------

describe("handleBootEvent exhaustiveness", { tags: ["unit"] }, () => {
	it("a switch over phase covers every variant without default", () => {
		function handleBootEvent(event: BootEvent): string {
			switch (event.phase) {
				case "storage":
					return `storage:${event.status}`;
				case "session":
					return event.status === "ready" ? `session:${event.sessionId}` : "session:picking";
				case "adapters":
					return event.status === "ready" ? `adapters:${event.adapterCount}` : "adapters:loading";
				case "model":
					return `model:${event.modelId}`;
				case "agent":
					return `agent:${event.status}`;
				case "error":
					return `error:${event.error}`;
			}
			const _exhaustive: never = event;
			return _exhaustive;
		}

		expect(handleBootEvent({ phase: "storage", status: "starting" })).toBe("storage:starting");
		expect(handleBootEvent({ phase: "error", error: "x" })).toBe("error:x");
		expect(handleBootEvent({ phase: "model", status: "ready", modelId: "m1" })).toBe("model:m1");
	});
});

// ---------------------------------------------------------------------------
// createBootstrapper sequence tests
// ---------------------------------------------------------------------------

describe("createBootstrapper", { tags: ["unit"] }, () => {
	it("runs the full boot sequence in order with TUI", async () => {
		const shell = stubShell();
		const phases: string[] = [];
		let wired = false;

		const config: BootstrapperConfig = {
			cwd: "/test",
			willUseTui: true,
			createShell: async () => shell,
			wireSession: () => {
				wired = true;
			},
			pickSession: async () => stubSelection(),
			resolveSession: async () => stubResolved(),
			getDeps: () => ({
				signalHandlers: new Map(),
				isCompacted: () => false,
				checkForUpdate: async () => null,
			}),
		};

		const handle = createBootstrapper(config);
		handle.subscribe((e) => phases.push(`${e.phase}:${"status" in e ? e.status : e.error}`));

		// Let the boot sequence run, then stop the TUI to unblock
		setTimeout(() => shell.resolve(), 50);
		await handle.done;

		expect(phases).toEqual([
			"session:picking",
			"session:ready",
			"adapters:loading",
			"adapters:ready",
			"model:ready",
			"agent:wiring",
			"agent:ready",
		]);
		expect(wired).toBe(true);
	});

	it("feeds lifecycle events to shell.handleBootEvent", async () => {
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

		expect(shell.bootEvents.length).toBeGreaterThan(0);
		expect(shell.bootEvents[0]!.phase).toBe("session");
	});

	it("runs without TUI in headless mode", async () => {
		const phases: string[] = [];
		let wired = false;

		const config: BootstrapperConfig = {
			cwd: "/test",
			willUseTui: false,
			createShell: async () => {
				throw new Error("should not be called");
			},
			wireSession: () => {
				wired = true;
			},
			pickSession: async () => stubSelection(),
			resolveSession: async () => stubResolved(),
			getDeps: () => ({
				signalHandlers: new Map(),
				isCompacted: () => false,
				checkForUpdate: async () => null,
			}),
		};

		const handle = createBootstrapper(config);
		handle.subscribe((e) => phases.push(e.phase));
		await handle.done;

		expect(phases).toContain("session");
		expect(phases).toContain("agent");
		// wireSession is not called in headless (no shell)
		expect(wired).toBe(false);
	});

	it("emits error event on failure", async () => {
		const phases: BootEvent[] = [];

		const config: BootstrapperConfig = {
			cwd: "/test",
			willUseTui: false,
			createShell: async () => {
				throw new Error("unused");
			},
			wireSession: () => {},
			pickSession: async () => {
				throw new Error("session pick failed");
			},
			resolveSession: async () => stubResolved(),
			getDeps: () => ({
				signalHandlers: new Map(),
				isCompacted: () => false,
				checkForUpdate: async () => null,
			}),
		};

		const handle = createBootstrapper(config);
		handle.subscribe((e) => phases.push(e));

		await expect(handle.done).rejects.toThrow("session pick failed");

		const errorEvent = phases.find((e) => e.phase === "error");
		expect(errorEvent).toBeDefined();
		if (errorEvent?.phase === "error") {
			expect(errorEvent.error).toBe("session pick failed");
		}
	});
});
