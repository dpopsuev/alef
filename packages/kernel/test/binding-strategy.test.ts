import { describe, expect, it } from "vitest";
import type { BindingExecutionStrategy, BindingStage } from "../src/binding.js";
import { executeBindingChain, registerBindingStrategy } from "../src/binding.js";
import { InProcessNerve } from "../src/in-process-nerve.js";
import { VALIDATE_REQUEST, VALIDATE_RESULT } from "../src/protocols.js";

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, n: nerve.asNerve() };
}

describe("Binding Execution Strategy Pattern", { tags: ["unit"] }, () => {
	it("uses OrderedStrategy for ordered mode", async () => {
		const { n } = makeNerve();

		// Set up validator that approves all stages
		const validationResults: string[] = [];
		const offMotor = n.motor.subscribe(VALIDATE_REQUEST, (event) => {
			const payload = event.payload as { id: string; targetOrgan: string };
			validationResults.push(payload.targetOrgan);
			n.sense.publish({
				type: VALIDATE_RESULT,
				correlationId: event.correlationId,
				payload: { id: payload.id, approved: true, reviewer: payload.targetOrgan },
			});
		});

		const binding = {
			id: "test-ordered",
			event: "test.ordered",
			mode: "ordered" as const,
			chain: [{ organ: "validator1" }, { organ: "validator2" }, { organ: "validator3" }] satisfies BindingStage[],
		};

		const result = await executeBindingChain(binding, { output: { test: true } }, n, "corr-1");

		expect(result.approved).toBe(true);
		expect(validationResults).toEqual(["validator1", "validator2", "validator3"]);

		offMotor();
	});

	it("uses ParallelAllStrategy for parallel-all mode", async () => {
		const { n } = makeNerve();

		const validationResults: string[] = [];
		const offMotor = n.motor.subscribe(VALIDATE_REQUEST, (event) => {
			const payload = event.payload as { id: string; targetOrgan: string };
			validationResults.push(payload.targetOrgan);
			// Approve after small delay to verify parallelism
			setTimeout(() => {
				n.sense.publish({
					type: VALIDATE_RESULT,
					correlationId: event.correlationId,
					payload: { id: payload.id, approved: true, reviewer: payload.targetOrgan },
				});
			}, 10);
		});

		const binding = {
			id: "test-parallel",
			event: "test.parallel",
			mode: "parallel-all" as const,
			chain: [{ organ: "validator1" }, { organ: "validator2" }, { organ: "validator3" }] satisfies BindingStage[],
		};

		const start = Date.now();
		const result = await executeBindingChain(binding, { output: { test: true } }, n, "corr-2");
		const elapsed = Date.now() - start;

		expect(result.approved).toBe(true);
		expect(validationResults).toHaveLength(3);
		// Should take ~10ms not ~30ms (parallel not sequential)
		expect(elapsed).toBeLessThan(50);

		offMotor();
	});

	it("parallel-all rejects if any stage rejects", async () => {
		const { n } = makeNerve();

		const offMotor = n.motor.subscribe(VALIDATE_REQUEST, (event) => {
			const payload = event.payload as { id: string; targetOrgan: string };
			// validator2 rejects
			const approved = payload.targetOrgan !== "validator2";
			n.sense.publish({
				type: VALIDATE_RESULT,
				correlationId: event.correlationId,
				payload: {
					id: payload.id,
					approved,
					reviewer: payload.targetOrgan,
					feedback: approved ? undefined : "rejected by validator2",
				},
			});
		});

		const binding = {
			id: "test-reject",
			event: "test.reject",
			mode: "parallel-all" as const,
			chain: [{ organ: "validator1" }, { organ: "validator2" }, { organ: "validator3" }] satisfies BindingStage[],
		};

		const result = await executeBindingChain(binding, { output: { test: true } }, n, "corr-3");

		expect(result.approved).toBe(false);
		expect(result.reviewer).toBe("validator2");
		expect(result.feedback).toBe("rejected by validator2");

		offMotor();
	});

	it("uses ParallelFirstStrategy for parallel-first mode", async () => {
		const { n } = makeNerve();

		let firstResponded = false;
		const offMotor = n.motor.subscribe(VALIDATE_REQUEST, (event) => {
			const payload = event.payload as { id: string; targetOrgan: string };
			// validator1 responds immediately, others delayed
			const delay = payload.targetOrgan === "validator1" ? 0 : 100;
			setTimeout(() => {
				if (!firstResponded && payload.targetOrgan === "validator1") {
					firstResponded = true;
				}
				n.sense.publish({
					type: VALIDATE_RESULT,
					correlationId: event.correlationId,
					payload: { id: payload.id, approved: true, reviewer: payload.targetOrgan },
				});
			}, delay);
		});

		const binding = {
			id: "test-first",
			event: "test.first",
			mode: "parallel-first" as const,
			chain: [{ organ: "validator1" }, { organ: "validator2" }, { organ: "validator3" }] satisfies BindingStage[],
		};

		const start = Date.now();
		const result = await executeBindingChain(binding, { output: { test: true } }, n, "corr-4");
		const elapsed = Date.now() - start;

		expect(result.approved).toBe(true);
		expect(result.reviewer).toBe("validator1");
		// Should return immediately (< 50ms), not wait for all (> 100ms)
		expect(elapsed).toBeLessThan(50);

		offMotor();
	});

	it("allows registration of custom strategies", async () => {
		const { n } = makeNerve();

		// Custom strategy that always approves without validation
		class AlwaysApproveStrategy implements BindingExecutionStrategy {
			async execute(): Promise<{ approved: boolean; reviewer: string }> {
				return { approved: true, reviewer: "always-approve-strategy" };
			}
		}

		registerBindingStrategy("custom-approve", new AlwaysApproveStrategy());

		const binding = {
			id: "test-custom",
			event: "test.custom",
			mode: "custom-approve" as any, // Cast needed since TypeScript doesn't know about custom mode
			chain: [{ organ: "validator1" }] satisfies BindingStage[],
		};

		const result = await executeBindingChain(binding, { output: { test: true } }, n, "corr-5");

		expect(result.approved).toBe(true);
		expect(result.reviewer).toBe("always-approve-strategy");
	});

	it("throws error for unknown binding mode", () => {
		const { n } = makeNerve();

		const binding = {
			id: "test-unknown",
			event: "test.unknown",
			mode: "nonexistent-mode" as any,
			chain: [{ organ: "validator1" }] satisfies BindingStage[],
		};

		expect(() => executeBindingChain(binding, { output: { test: true } }, n, "corr-6")).toThrow(
			"Unknown binding mode: nonexistent-mode",
		);
	});

	it("ordered strategy stops on first rejection", async () => {
		const { n } = makeNerve();

		const executedStages: string[] = [];
		const offMotor = n.motor.subscribe(VALIDATE_REQUEST, (event) => {
			const payload = event.payload as { id: string; targetOrgan: string };
			executedStages.push(payload.targetOrgan);
			// validator2 rejects
			const approved = payload.targetOrgan !== "validator2";
			n.sense.publish({
				type: VALIDATE_RESULT,
				correlationId: event.correlationId,
				payload: { id: payload.id, approved, reviewer: payload.targetOrgan },
			});
		});

		const binding = {
			id: "test-stop",
			event: "test.stop",
			mode: "ordered" as const,
			chain: [{ organ: "validator1" }, { organ: "validator2" }, { organ: "validator3" }] satisfies BindingStage[],
		};

		const result = await executeBindingChain(binding, { output: { test: true } }, n, "corr-7");

		expect(result.approved).toBe(false);
		expect(result.reviewer).toBe("validator2");
		// Should not execute validator3 after validator2 rejects
		expect(executedStages).toEqual(["validator1", "validator2"]);

		offMotor();
	});
});
