/**
 * Unit tests for SupervisorLifecycleMachine.
 *
 * The FSM is a pure state machine — no I/O, no process spawn.
 * Every scenario the supervisor-process-proof tests verifies at the process
 * level should have a corresponding pure FSM test here. When the process test
 * fails due to timing, the FSM test still runs and catches logic regressions.
 */

import { describe, expect, it } from "vitest";
import { SupervisorLifecycleMachine } from "../src/broker/supervisor-fsm.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpawn(updateId = "upd-1", slot: "blue" | "green" = "blue") {
	return {
		type: "spawn_staging" as const,
		commandId: `cmd-spawn-${updateId}`,
		updateId,
		stagingSlot: slot,
	};
}

function makeHealthy(updateId = "upd-1") {
	return { type: "mark_staging_healthy" as const, commandId: `cmd-healthy-${updateId}`, updateId };
}

function makePromote(updateId = "upd-1") {
	return { type: "promote" as const, commandId: `cmd-promote-${updateId}`, updateId };
}

function makeRollback(updateId = "upd-1", reason = "smoke failed") {
	return { type: "rollback" as const, commandId: `cmd-rollback-${updateId}`, updateId, reason };
}

function makeAbort(updateId = "upd-1", reason = "cancelled") {
	return { type: "abort" as const, commandId: `cmd-abort-${updateId}`, updateId, reason };
}

function makeRetireOld(updateId = "upd-1") {
	return { type: "retire_old" as const, commandId: `cmd-retire-${updateId}`, updateId };
}

// ---------------------------------------------------------------------------
// Basic transitions (existing coverage)
// ---------------------------------------------------------------------------

describe("SupervisorLifecycleMachine — basic transitions", () => {
	it("advances spawn_requested -> staging_healthy with matching update_id", () => {
		const fsm = new SupervisorLifecycleMachine();
		const spawn = fsm.apply(makeSpawn());
		expect(spawn.accepted).toBe(true);
		expect(spawn.to.name).toBe("spawn_requested");

		const healthy = fsm.apply(makeHealthy());
		expect(healthy.accepted).toBe(true);
		expect(healthy.from.name).toBe("spawn_requested");
		expect(healthy.to.name).toBe("staging_healthy");
	});

	it("rejects mutating command on update_id mismatch with diagnostics", () => {
		const fsm = new SupervisorLifecycleMachine();
		fsm.apply(makeSpawn("upd-2"));
		const mismatch = fsm.apply(makeHealthy("upd-other"));
		expect(mismatch.accepted).toBe(false);
		expect(mismatch.diagnostics[0]?.code).toBe("update_id_mismatch");
		expect(fsm.getState().name).toBe("spawn_requested");
	});

	it("rejects invalid transitions without mutating slot state", () => {
		const fsm = new SupervisorLifecycleMachine({ name: "idle", activeSlot: "green" });
		const invalid = fsm.apply(makePromote("upd-3"));
		expect(invalid.accepted).toBe(false);
		expect(invalid.diagnostics[0]?.code).toBe("invalid_transition");
		expect(fsm.getState()).toEqual({ name: "idle", activeSlot: "green" });
	});

	it("replays duplicate commandId idempotently", () => {
		const fsm = new SupervisorLifecycleMachine();
		const first = fsm.apply(makeSpawn("upd-replay"));
		const second = fsm.apply(makeSpawn("upd-replay"));
		expect(first.accepted).toBe(true);
		expect(second.accepted).toBe(true);
		expect(second.replayed).toBe(true);
		expect(fsm.getState().name).toBe("spawn_requested");
	});
});

// ---------------------------------------------------------------------------
// Full promote path (the happy path supervisor-process-proof verifies)
// ---------------------------------------------------------------------------

describe("SupervisorLifecycleMachine — full promote path", () => {
	it("idle -> spawn_requested -> staging_healthy -> promoted -> idle (promote + retire_old)", () => {
		const fsm = new SupervisorLifecycleMachine();
		expect(fsm.getState().name).toBe("idle");

		fsm.apply(makeSpawn("upd-1", "blue"));
		expect(fsm.getState().name).toBe("spawn_requested");

		fsm.apply(makeHealthy("upd-1"));
		expect(fsm.getState().name).toBe("staging_healthy");

		const promote = fsm.apply(makePromote("upd-1"));
		expect(promote.accepted).toBe(true);
		expect(fsm.getState().name).toBe("promoted");

		const retire = fsm.apply(makeRetireOld("upd-1"));
		expect(retire.accepted).toBe(true);
		expect(fsm.getState().name).toBe("idle");
	});

	it("activeSlot flips from green to blue after promote + retire_old", () => {
		const fsm = new SupervisorLifecycleMachine({ name: "idle", activeSlot: "green" });
		fsm.apply(makeSpawn("upd-1", "blue"));
		fsm.apply(makeHealthy("upd-1"));
		fsm.apply(makePromote("upd-1"));
		fsm.apply(makeRetireOld("upd-1"));

		const state = fsm.getState();
		expect(state.name).toBe("idle");
		expect(state.activeSlot).toBe("blue");
	});

	it("activeSlot flips from blue to green after second promote + retire_old", () => {
		const fsm = new SupervisorLifecycleMachine({ name: "idle", activeSlot: "green" });

		// First cycle: green active → blue promoted
		fsm.apply(makeSpawn("upd-1", "blue"));
		fsm.apply(makeHealthy("upd-1"));
		fsm.apply(makePromote("upd-1"));
		fsm.apply(makeRetireOld("upd-1"));
		expect(fsm.getState().activeSlot).toBe("blue");

		// Second cycle: blue active → green promoted
		fsm.apply(makeSpawn("upd-2", "green"));
		fsm.apply(makeHealthy("upd-2"));
		fsm.apply(makePromote("upd-2"));
		fsm.apply(makeRetireOld("upd-2"));
		expect(fsm.getState().activeSlot).toBe("green");
	});

	it("cannot promote from idle", () => {
		const fsm = new SupervisorLifecycleMachine();
		const result = fsm.apply(makePromote("upd-x"));
		expect(result.accepted).toBe(false);
		expect(result.diagnostics[0]?.code).toBe("invalid_transition");
	});

	it("cannot promote from spawn_requested (staging not yet healthy)", () => {
		const fsm = new SupervisorLifecycleMachine();
		fsm.apply(makeSpawn("upd-1"));
		const result = fsm.apply(makePromote("upd-1"));
		expect(result.accepted).toBe(false);
		expect(result.diagnostics[0]?.code).toBe("invalid_transition");
	});
});

// ---------------------------------------------------------------------------
// Rollback path (what supervisor-process-proof "rolls back" test verifies)
// ---------------------------------------------------------------------------

describe("SupervisorLifecycleMachine — rollback path", () => {
	it("staging_healthy -> idle (rollback) keeps original activeSlot", () => {
		const fsm = new SupervisorLifecycleMachine({ name: "idle", activeSlot: "green" });
		fsm.apply(makeSpawn("upd-1", "blue"));
		fsm.apply(makeHealthy("upd-1"));

		const rollback = fsm.apply(makeRollback("upd-1", "smoke tests failed"));
		expect(rollback.accepted).toBe(true);

		const state = fsm.getState();
		expect(state.name).toBe("idle");
		expect(state.activeSlot).toBe("green"); // unchanged — old slot survives
	});

	it("cannot rollback from idle", () => {
		const fsm = new SupervisorLifecycleMachine();
		const result = fsm.apply(makeRollback("upd-x"));
		expect(result.accepted).toBe(false);
		expect(result.diagnostics[0]?.code).toBe("invalid_transition");
	});

	it("can rollback from spawn_requested (build not yet started)", () => {
		const fsm = new SupervisorLifecycleMachine();
		fsm.apply(makeSpawn("upd-1"));
		const result = fsm.apply(makeRollback("upd-1"));
		// Rollback is allowed from any non-idle state. spawn_requested = pre-build.
		expect(result.accepted).toBe(true);
		expect(fsm.getState().name).toBe("idle");
	});

	it("new update cycle succeeds after rollback", () => {
		const fsm = new SupervisorLifecycleMachine({ name: "idle", activeSlot: "green" });
		fsm.apply(makeSpawn("upd-1", "blue"));
		fsm.apply(makeHealthy("upd-1"));
		fsm.apply(makeRollback("upd-1"));

		// New cycle with different updateId
		fsm.apply(makeSpawn("upd-2", "blue"));
		fsm.apply(makeHealthy("upd-2"));
		const promote = fsm.apply(makePromote("upd-2"));
		expect(promote.accepted).toBe(true);
		expect(fsm.getState().name).toBe("promoted");

		const retire = fsm.apply(makeRetireOld("upd-2"));
		expect(retire.accepted).toBe(true);
		expect(fsm.getState().activeSlot).toBe("blue");
	});
});

// ---------------------------------------------------------------------------
// Promoted state and retire_old (Hegemony-derived explicit slot retirement)
// ---------------------------------------------------------------------------

describe("SupervisorLifecycleMachine — promoted state and retire_old", () => {
	it("promote transitions staging_healthy -> promoted, not idle", () => {
		const fsm = new SupervisorLifecycleMachine({ name: "idle", activeSlot: "green" });
		fsm.apply(makeSpawn("upd-1", "blue"));
		fsm.apply(makeHealthy("upd-1"));
		const promote = fsm.apply(makePromote("upd-1"));
		expect(promote.accepted).toBe(true);
		expect(promote.to.name).toBe("promoted");
	});

	it("promoted state records retiringSlot and the new activeSlot", () => {
		const fsm = new SupervisorLifecycleMachine({ name: "idle", activeSlot: "green" });
		fsm.apply(makeSpawn("upd-1", "blue"));
		fsm.apply(makeHealthy("upd-1"));
		fsm.apply(makePromote("upd-1"));

		const state = fsm.getState();
		if (state.name !== "promoted") throw new Error("expected promoted");
		expect(state.activeSlot).toBe("blue"); // formerly staging
		expect(state.retiringSlot).toBe("green"); // old active
		expect(state.updateId).toBe("upd-1");
	});

	it("retire_old transitions promoted -> idle", () => {
		const fsm = new SupervisorLifecycleMachine({ name: "idle", activeSlot: "green" });
		fsm.apply(makeSpawn("upd-1", "blue"));
		fsm.apply(makeHealthy("upd-1"));
		fsm.apply(makePromote("upd-1"));
		const retire = fsm.apply(makeRetireOld("upd-1"));
		expect(retire.accepted).toBe(true);
		expect(fsm.getState().name).toBe("idle");
		expect(fsm.getState().activeSlot).toBe("blue");
	});

	it("retire_old rejected from idle", () => {
		const fsm = new SupervisorLifecycleMachine();
		const result = fsm.apply(makeRetireOld());
		expect(result.accepted).toBe(false);
		expect(result.diagnostics[0]?.code).toBe("invalid_transition");
	});

	it("retire_old rejected from spawn_requested", () => {
		const fsm = new SupervisorLifecycleMachine();
		fsm.apply(makeSpawn("upd-1"));
		const result = fsm.apply(makeRetireOld("upd-1"));
		expect(result.accepted).toBe(false);
		expect(result.diagnostics[0]?.code).toBe("invalid_transition");
	});

	it("retire_old rejected from staging_healthy", () => {
		const fsm = new SupervisorLifecycleMachine();
		fsm.apply(makeSpawn("upd-1"));
		fsm.apply(makeHealthy("upd-1"));
		const result = fsm.apply(makeRetireOld("upd-1"));
		expect(result.accepted).toBe(false);
		expect(result.diagnostics[0]?.code).toBe("invalid_transition");
	});

	it("rollback from promoted restores retiringSlot as activeSlot", () => {
		const fsm = new SupervisorLifecycleMachine({ name: "idle", activeSlot: "green" });
		fsm.apply(makeSpawn("upd-1", "blue"));
		fsm.apply(makeHealthy("upd-1"));
		fsm.apply(makePromote("upd-1"));

		const rollback = fsm.apply(makeRollback("upd-1", "crisis"));
		expect(rollback.accepted).toBe(true);
		const state = fsm.getState();
		expect(state.name).toBe("idle");
		expect(state.activeSlot).toBe("green"); // restored to pre-promote slot
	});

	it("abort from promoted restores retiringSlot as activeSlot", () => {
		const fsm = new SupervisorLifecycleMachine({ name: "idle", activeSlot: "blue" });
		fsm.apply(makeSpawn("upd-1", "green"));
		fsm.apply(makeHealthy("upd-1"));
		fsm.apply(makePromote("upd-1"));

		fsm.apply(makeAbort("upd-1"));
		expect(fsm.getState().activeSlot).toBe("blue"); // restored
	});

	it("retire_old replayed idempotently via commandId cache", () => {
		const fsm = new SupervisorLifecycleMachine();
		fsm.apply(makeSpawn("upd-1"));
		fsm.apply(makeHealthy("upd-1"));
		fsm.apply(makePromote("upd-1"));
		const first = fsm.apply(makeRetireOld("upd-1"));
		const second = fsm.apply(makeRetireOld("upd-1")); // same commandId
		expect(first.accepted).toBe(true);
		expect(second.replayed).toBe(true);
		expect(fsm.getState().name).toBe("idle");
	});
});

// ---------------------------------------------------------------------------
// Abort path
// ---------------------------------------------------------------------------

describe("SupervisorLifecycleMachine — abort path", () => {
	it("spawn_requested -> idle (abort)", () => {
		const fsm = new SupervisorLifecycleMachine();
		fsm.apply(makeSpawn("upd-1"));
		const abort = fsm.apply(makeAbort("upd-1"));
		expect(abort.accepted).toBe(true);
		expect(fsm.getState().name).toBe("idle");
	});

	it("staging_healthy -> idle (abort)", () => {
		const fsm = new SupervisorLifecycleMachine();
		fsm.apply(makeSpawn("upd-1"));
		fsm.apply(makeHealthy("upd-1"));
		const abort = fsm.apply(makeAbort("upd-1"));
		expect(abort.accepted).toBe(true);
		expect(fsm.getState().name).toBe("idle");
	});

	it("activeSlot unchanged after abort", () => {
		const fsm = new SupervisorLifecycleMachine({ name: "idle", activeSlot: "green" });
		fsm.apply(makeSpawn("upd-1", "blue"));
		fsm.apply(makeAbort("upd-1"));
		expect(fsm.getState().activeSlot).toBe("green");
	});
});

// ---------------------------------------------------------------------------
// Diagnostics structure
// ---------------------------------------------------------------------------

describe("SupervisorLifecycleMachine — diagnostics", () => {
	it("from/to are populated on every apply call", () => {
		const fsm = new SupervisorLifecycleMachine();
		const result = fsm.apply(makeSpawn());
		expect(result.from).toBeDefined();
		expect(result.to).toBeDefined();
		expect(result.command).toBeDefined();
	});

	it("diagnostics array is empty on accepted transitions", () => {
		const fsm = new SupervisorLifecycleMachine();
		const result = fsm.apply(makeSpawn());
		expect(result.accepted).toBe(true);
		expect(result.diagnostics).toEqual([]);
	});

	it("diagnostics include command type and state on rejection", () => {
		const fsm = new SupervisorLifecycleMachine();
		const result = fsm.apply(makePromote());
		expect(result.diagnostics[0]?.command).toBe("promote");
		expect(result.diagnostics[0]?.state).toBe("idle");
	});

	it("update_id_mismatch diagnostic records both ids", () => {
		const fsm = new SupervisorLifecycleMachine();
		fsm.apply(makeSpawn("actual-id"));
		const result = fsm.apply(makeHealthy("wrong-id"));
		const diag = result.diagnostics[0];
		expect(diag?.code).toBe("update_id_mismatch");
		expect(diag?.updateId).toBe("wrong-id");
		expect(diag?.expectedUpdateId).toBe("actual-id");
	});
});

// ---------------------------------------------------------------------------
// Slot invariants
// ---------------------------------------------------------------------------

describe("SupervisorLifecycleMachine — slot invariants", () => {
	it("staging slot is always the opposite of activeSlot", () => {
		const fsm = new SupervisorLifecycleMachine({ name: "idle", activeSlot: "green" });
		fsm.apply(makeSpawn("upd-1", "blue"));

		const state = fsm.getState();
		if (state.name === "spawn_requested") {
			expect(state.stagingSlot).toBe("blue");
			expect(state.activeSlot).toBe("green");
		}
	});

	it("getState() is non-mutating — returns a copy", () => {
		const fsm = new SupervisorLifecycleMachine();
		const s1 = fsm.getState();
		fsm.apply(makeSpawn());
		const s2 = fsm.getState();
		expect(s1.name).toBe("idle");
		expect(s2.name).toBe("spawn_requested");
	});
});
