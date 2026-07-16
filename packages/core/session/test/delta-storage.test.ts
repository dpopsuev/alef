import { describe, expect, it } from "vitest";
import { applyDelta, DeltaChannel, reconstructHistory } from "../src/delta-channel.js";
import type { MessageDelta, MessageSnapshot } from "../src/contracts/storage.js";

describe("DeltaChannel - Message delta storage", { tags: ["unit"] }, () => {
	describe("computeDelta via DeltaChannel", () => {
		it("detects append operations", () => {
			const channel = new DeltaChannel();
			const m1 = { role: "user", content: "hello" };
			const m2 = { role: "assistant", content: "hi there" };

			const result = channel.processCheckpoint([m1]);
			expect(result).toMatchObject({
				sequence: 1,
				operations: [{ type: "append", message: m1 }],
			});

			const result2 = channel.processCheckpoint([m1, m2]);
			expect(result2).toMatchObject({
				sequence: 2,
				operations: [{ type: "append", message: m2 }],
			});
		});

		it("detects remove operations", () => {
			const channel = new DeltaChannel();
			const m1 = { role: "user", content: "hello" };
			const m2 = { role: "assistant", content: "hi there" };

			channel.processCheckpoint([m1, m2]);
			const result = channel.processCheckpoint([m1]);

			expect(result).toMatchObject({
				sequence: 2,
				operations: [{ type: "remove", index: 1 }],
			});
		});

		it("returns null when no changes", () => {
			const channel = new DeltaChannel();
			const m1 = { role: "user", content: "hello" };

			channel.processCheckpoint([m1]);
			const result = channel.processCheckpoint([m1]);

			expect(result).toBeNull();
		});

		it("creates snapshot every 50 checkpoints", () => {
			const channel = new DeltaChannel();
			const messages = [{ role: "user", content: "test" }];

			// First 49 should be deltas
			for (let i = 1; i < 50; i++) {
				const result = channel.processCheckpoint(messages);
				if (i === 1) {
					expect(result).toMatchObject({ operations: expect.any(Array) });
				} else {
					expect(result).toBeNull(); // No change
				}
			}

			// 50th should be snapshot
			const m2 = { role: "assistant", content: "response" };
			const result = channel.processCheckpoint([...messages, m2]);
			expect(result).toMatchObject({
				sequence: 50,
				messages: expect.any(Array),
			});
			expect((result as MessageSnapshot).messages).toHaveLength(2);
		});
	});

	describe("applyDelta", () => {
		it("applies append operations", () => {
			const base = [{ role: "user", content: "hello" }];
			const m2 = { role: "assistant", content: "hi" };
			const result = applyDelta(base, [{ type: "append", message: m2 }]);

			expect(result).toEqual([
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hi" },
			]);
		});

		it("applies remove operations", () => {
			const base = [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hi" },
			];
			const result = applyDelta(base, [{ type: "remove", index: 1 }]);

			expect(result).toEqual([{ role: "user", content: "hello" }]);
		});

		it("applies replace operations", () => {
			const base = [{ role: "user", content: "hello" }];
			const m2 = { role: "user", content: "hello updated" };
			const result = applyDelta(base, [{ type: "replace", index: 0, message: m2 }]);

			expect(result).toEqual([{ role: "user", content: "hello updated" }]);
		});

		it("handles multiple operations in sequence", () => {
			const base = [{ role: "user", content: "1" }];
			const result = applyDelta(base, [
				{ type: "append", message: { role: "assistant", content: "2" } },
				{ type: "append", message: { role: "user", content: "3" } },
				{ type: "remove", index: 0 },
			]);

			expect(result).toEqual([
				{ role: "assistant", content: "2" },
				{ role: "user", content: "3" },
			]);
		});
	});

	describe("reconstructHistory", () => {
		it("reconstructs from snapshot + deltas", () => {
			const snapshot: MessageSnapshot = {
				sequence: 10,
				messages: [
					{ role: "user", content: "old1" },
					{ role: "assistant", content: "old2" },
				],
				timestamp: Date.now(),
			};

			const delta1: MessageDelta = {
				sequence: 11,
				operations: [{ type: "append", message: { role: "user", content: "new1" } }],
				timestamp: Date.now(),
			};

			const delta2: MessageDelta = {
				sequence: 12,
				operations: [{ type: "append", message: { role: "assistant", content: "new2" } }],
				timestamp: Date.now(),
			};

			const result = reconstructHistory([snapshot], [delta1, delta2]);

			expect(result).toEqual([
				{ role: "user", content: "old1" },
				{ role: "assistant", content: "old2" },
				{ role: "user", content: "new1" },
				{ role: "assistant", content: "new2" },
			]);
		});

		it("uses latest snapshot when multiple exist", () => {
			const snapshot1: MessageSnapshot = {
				sequence: 5,
				messages: [{ role: "user", content: "early" }],
				timestamp: Date.now() - 1000,
			};

			const snapshot2: MessageSnapshot = {
				sequence: 10,
				messages: [
					{ role: "user", content: "latest1" },
					{ role: "assistant", content: "latest2" },
				],
				timestamp: Date.now(),
			};

			const delta: MessageDelta = {
				sequence: 11,
				operations: [{ type: "append", message: { role: "user", content: "after" } }],
				timestamp: Date.now(),
			};

			const result = reconstructHistory([snapshot1, snapshot2], [delta]);

			expect(result).toEqual([
				{ role: "user", content: "latest1" },
				{ role: "assistant", content: "latest2" },
				{ role: "user", content: "after" },
			]);
		});

		it("ignores deltas before snapshot", () => {
			const snapshot: MessageSnapshot = {
				sequence: 10,
				messages: [{ role: "user", content: "base" }],
				timestamp: Date.now(),
			};

			const oldDelta: MessageDelta = {
				sequence: 5,
				operations: [{ type: "append", message: { role: "assistant", content: "old" } }],
				timestamp: Date.now() - 1000,
			};

			const newDelta: MessageDelta = {
				sequence: 11,
				operations: [{ type: "append", message: { role: "assistant", content: "new" } }],
				timestamp: Date.now(),
			};

			const result = reconstructHistory([snapshot], [oldDelta, newDelta]);

			expect(result).toEqual([
				{ role: "user", content: "base" },
				{ role: "assistant", content: "new" },
			]);
		});

		it("handles empty snapshot and deltas", () => {
			const result = reconstructHistory([], []);
			expect(result).toEqual([]);
		});

		it("reconstructs from deltas only (no snapshot)", () => {
			const delta1: MessageDelta = {
				sequence: 1,
				operations: [{ type: "append", message: { role: "user", content: "first" } }],
				timestamp: Date.now(),
			};

			const delta2: MessageDelta = {
				sequence: 2,
				operations: [{ type: "append", message: { role: "assistant", content: "second" } }],
				timestamp: Date.now(),
			};

			const result = reconstructHistory([], [delta1, delta2]);

			expect(result).toEqual([
				{ role: "user", content: "first" },
				{ role: "assistant", content: "second" },
			]);
		});
	});

	describe("DeltaChannel state management", () => {
		it("reset restores sequence and state", () => {
			const channel = new DeltaChannel();
			const messages = [
				{ role: "user", content: "1" },
				{ role: "assistant", content: "2" },
			];

			channel.reset(messages, 100);

			// Next checkpoint should be sequence 101
			const m3 = { role: "user", content: "3" };
			const result = channel.processCheckpoint([...messages, m3]);

			expect(result).toMatchObject({
				sequence: 101,
				operations: [{ type: "append", message: m3 }],
			});
		});

		it("tracks checkpoints since snapshot correctly", () => {
			const channel = new DeltaChannel();
			const m1 = { role: "user", content: "test" };

			// First checkpoint
			channel.processCheckpoint([m1]);

			// Reset to high sequence
			channel.reset([m1], 48);

			// Next checkpoint should be 49 (no snapshot yet)
			const m2 = { role: "assistant", content: "response" };
			let result = channel.processCheckpoint([m1, m2]);
			expect(result).toMatchObject({ operations: expect.any(Array) });

			// Checkpoint 50 should trigger snapshot
			const m3 = { role: "user", content: "follow-up" };
			result = channel.processCheckpoint([m1, m2, m3]);
			expect(result).toMatchObject({
				sequence: 50,
				messages: expect.any(Array),
			});
		});
	});

	describe("Integration: 100+ checkpoints", () => {
		it("reconstructs correctly after 100+ deltas with snapshots", () => {
			const channel = new DeltaChannel();
			const snapshots: MessageSnapshot[] = [];
			const deltas: MessageDelta[] = [];
			const messages: unknown[] = [];

			// Simulate 120 checkpoints
			for (let i = 1; i <= 120; i++) {
				messages.push({ role: i % 2 === 0 ? "assistant" : "user", content: `msg${i}` });
				const result = channel.processCheckpoint(messages.slice());

				if (result) {
					if ("messages" in result) {
						snapshots.push(result as MessageSnapshot);
					} else {
						deltas.push(result as MessageDelta);
					}
				}
			}

			// Should have snapshots at 50 and 100
			expect(snapshots).toHaveLength(2);
			expect(snapshots[0]?.sequence).toBe(50);
			expect(snapshots[1]?.sequence).toBe(100);

			// Reconstruct and verify matches original
			const reconstructed = reconstructHistory(snapshots, deltas);
			expect(reconstructed).toHaveLength(120);
			expect(reconstructed).toEqual(messages);
		});
	});
});
