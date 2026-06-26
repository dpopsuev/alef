import { describe, expect, it } from "vitest";
import type { StorageRecord } from "../src/contracts/storage.js";
import { buildSessionIndex, reconstructAllTurns, reconstructTurn } from "../src/tracing/reconstructor.js";

function record(bus: StorageRecord["bus"], type: string, correlationId: string, payload: Record<string, unknown> = {}): StorageRecord {
	return { bus, type, correlationId, payload, timestamp: Date.now() };
}

function llmInput(correlationId: string, text: string): StorageRecord {
	return record("event", "llm.input", correlationId, { text, sender: "human" });
}

function llmResponse(correlationId: string, text: string, history?: unknown[]): StorageRecord {
	return record("command", "llm.response", correlationId, { text, ...(history ? { conversationHistory: history } : {}) });
}

function toolCommand(correlationId: string, type: string): StorageRecord {
	return record("command", type, correlationId);
}

function llmResult(correlationId: string, turn: number, toolCalls: Array<{ name: string }> = []): StorageRecord {
	return record("notification", "llm.result", correlationId, { turn, toolCalls });
}

function windowAssembled(turnIds: string[], budgetUsed: number, budgetTotal: number): StorageRecord {
	return record("internal", "window.assembled", `wa-${Date.now()}`, { includedTurnIds: turnIds, budgetUsed, budgetTotal });
}

describe("Context Reconstructor", { tags: ["unit"] }, () => {
	it("buildSessionIndex groups records into turns", () => {
		const records = [
			llmInput("c-1", "hello"),
			llmResponse("c-1", "hi"),
			llmInput("c-2", "next"),
			llmResponse("c-2", "ok"),
		];

		const index = buildSessionIndex(records);
		expect(index.turns).toHaveLength(2);
		expect(index.turns[0].id).toBe("c-1");
		expect(index.turns[1].id).toBe("c-2");
	});

	it("reconstructTurn returns snapshot for a given turn", () => {
		const records = [
			llmInput("c-1", "hello"),
			llmResponse("c-1", "hi", [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }]),
			windowAssembled(["c-1"], 100, 140_000),
		];

		const index = buildSessionIndex(records);
		const snapshot = reconstructTurn(index, 0);

		expect(snapshot).toBeDefined();
		expect(snapshot!.turn).toBe(0);
		expect(snapshot!.correlationId).toBe("c-1");
		expect(snapshot!.messageCount).toBe(2);
		expect(snapshot!.messageRoles).toEqual(["user", "assistant"]);
		expect(snapshot!.catalogState).toBe("injected");
	});

	it("tracks tool promotion from llm.result events", () => {
		const records = [
			llmInput("c-1", "hello"),
			llmResult("c-1", 0, [{ name: "fs.read" }]),
			llmResponse("c-1", "done"),
			llmInput("c-2", "next"),
			llmResult("c-2", 1, [{ name: "shell.exec" }]),
			llmResponse("c-2", "ok"),
		];

		const index = buildSessionIndex(records);

		const snap0 = reconstructTurn(index, 0);
		expect(snap0!.promotedNamespaces).toContain("fs");

		const snap1 = reconstructTurn(index, 1);
		expect(snap1!.promotedNamespaces).toContain("fs");
		expect(snap1!.promotedNamespaces).toContain("shell");
	});

	it("hitCounts match window.assembled records", () => {
		const records = [
			llmInput("c-1", "hello"),
			llmResponse("c-1", "hi"),
			llmInput("c-2", "next"),
			llmResponse("c-2", "ok"),
			windowAssembled(["c-1", "c-2"], 200, 140_000),
			windowAssembled(["c-1"], 100, 140_000),
		];

		const index = buildSessionIndex(records);
		expect(index.hitCounts.get("c-1")).toBe(2);
		expect(index.hitCounts.get("c-2")).toBe(1);
	});

	it("catalog state transitions correctly", () => {
		const records: StorageRecord[] = [];
		for (let i = 0; i < 5; i++) {
			const cid = `c-${i}`;
			records.push(llmInput(cid, `msg ${i}`));
			records.push(llmResponse(cid, `reply ${i}`));
		}

		const snapshots = reconstructAllTurns(records, 3);
		expect(snapshots[0].catalogState).toBe("injected");
		expect(snapshots[1].catalogState).toBe("present");
		expect(snapshots[2].catalogState).toBe("present");
		expect(snapshots[3].catalogState).toBe("present");
		expect(snapshots[4].catalogState).toBe("evicted");
	});

	it("reconstructAllTurns returns all turns in order", () => {
		const records = [
			llmInput("c-1", "first"),
			llmResponse("c-1", "r1"),
			llmInput("c-2", "second"),
			llmResponse("c-2", "r2"),
			llmInput("c-3", "third"),
			llmResponse("c-3", "r3"),
		];

		const snapshots = reconstructAllTurns(records);
		expect(snapshots).toHaveLength(3);
		expect(snapshots.map((s) => s.turn)).toEqual([0, 1, 2]);
	});

	it("returns undefined for non-existent turn", () => {
		const index = buildSessionIndex([]);
		expect(reconstructTurn(index, 99)).toBeUndefined();
	});

	it("captures tool calls from turn events", () => {
		const records = [
			llmInput("c-1", "read file"),
			toolCommand("c-1", "fs.read"),
			llmResult("c-1", 0, [{ name: "fs.read" }]),
			llmResponse("c-1", "content"),
		];

		const index = buildSessionIndex(records);
		const snapshot = reconstructTurn(index, 0);
		expect(snapshot!.toolNames).toContain("fs.read");
	});
});
