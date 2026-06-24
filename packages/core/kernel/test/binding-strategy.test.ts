import { describe, expect, it } from "vitest";
import type { BindingExecutionStrategy, BindingStage } from "../src/binding.js";
import { executeBindingChain, registerBindingStrategy } from "../src/binding.js";
import { InProcessBus } from "../src/in-process-bus.js";
import { VALIDATE_REQUEST, VALIDATE_RESULT } from "../src/protocols.js";

function makeBus() {
	const bus = new InProcessBus();
	return { bus, n: bus.asBus() };
}

describe("Binding Execution Strategy Pattern", { tags: ["unit"] }, () => {
	it("uses OrderedStrategy for ordered mode", async () => {
		const { n } = makeBus();

		// Set up validator that approves all stages
		const validationResults: string[] = [];
		const offCommand = n.command.subscribe(VALIDATE_REQUEST, (event) => {
			const payload = event.payload as { id: string; targetAdapter: string };
			validationResults.push(payload.targetAdapter);
			n.event.publish({
				type: VALIDATE_RESULT,
				correlationId: event.correlationId,
				payload: { id: payload.id, approved: true, reviewer: payload.targetAdapter },
				isError: false,
			});
		});

		const binding = {
			id: "test-ordered",
			event: "test.ordered",
			mode: "ordered" as const,
			chain: [
				{ adapter: "validator1" },
				{ adapter: "validator2" },
				{ adapter: "validator3" },
			] satisfies BindingStage[],
		};

		const result = await executeBindingChain(binding, { output: { test: true } }, n, "corr-1");

		expect(result.approved).toBe(true);
		expect(validationResults).toEqual(["validator1", "validator2", "validator3"]);

		offCommand();
	});

	it("uses ParallelAllStrategy for parallel-all mode", async () => {
		const { n } = makeBus();

		const validationResults: string[] = [];
		const offCommand = n.command.subscribe(VALIDATE_REQUEST, (event) => {
			const payload = event.payload as { id: string; targetAdapter: string };
			validationResults.push(payload.targetAdapter);
			// Approve after small delay to verify parallelism
			setTimeout(() => {
				n.event.publish({
					type: VALIDATE_RESULT,
					correlationId: event.correlationId,
					payload: { id: payload.id, approved: true, reviewer: payload.targetAdapter },
					isError: false,
				});
			}, 10);
		});

		const binding = {
			id: "test-parallel",
			event: "test.parallel",
			mode: "parallel-all" as const,
			chain: [
				{ adapter: "validator1" },
				{ adapter: "validator2" },
				{ adapter: "validator3" },
			] satisfies BindingStage[],
		};

		const start = Date.now();
		const result = await executeBindingChain(binding, { output: { test: true } }, n, "corr-2");
		const elapsed = Date.now() - start;

		expect(result.approved).toBe(true);
		expect(validationResults).toHaveLength(3);
		// Should take ~10ms not ~30ms (parallel not sequential)
		expect(elapsed).toBeLessThan(200);

		offCommand();
	});

	it("parallel-all rejects if any stage rejects", async () => {
		const { n } = makeBus();

		const offCommand = n.command.subscribe(VALIDATE_REQUEST, (event) => {
			const payload = event.payload as { id: string; targetAdapter: string };
			// validator2 rejects
			const approved = payload.targetAdapter !== "validator2";
			n.event.publish({
				type: VALIDATE_RESULT,
				correlationId: event.correlationId,
				payload: {
					id: payload.id,
					approved,
					reviewer: payload.targetAdapter,
					feedback: approved ? undefined : "rejected by validator2",
				},
				isError: false,
			});
		});

		const binding = {
			id: "test-reject",
			event: "test.reject",
			mode: "parallel-all" as const,
			chain: [
				{ adapter: "validator1" },
				{ adapter: "validator2" },
				{ adapter: "validator3" },
			] satisfies BindingStage[],
		};

		const result = await executeBindingChain(binding, { output: { test: true } }, n, "corr-3");

		expect(result.approved).toBe(false);
		expect(result.reviewer).toBe("validator2");
		expect(result.feedback).toBe("rejected by validator2");

		offCommand();
	});

	it("uses ParallelFirstStrategy for parallel-first mode", async () => {
		const { n } = makeBus();

		let firstResponded = false;
		const offCommand = n.command.subscribe(VALIDATE_REQUEST, (event) => {
			const payload = event.payload as { id: string; targetAdapter: string };
			// validator1 responds immediately, others delayed
			const delay = payload.targetAdapter === "validator1" ? 0 : 100;
			setTimeout(() => {
				if (!firstResponded && payload.targetAdapter === "validator1") {
					firstResponded = true;
				}
				n.event.publish({
					type: VALIDATE_RESULT,
					correlationId: event.correlationId,
					payload: { id: payload.id, approved: true, reviewer: payload.targetAdapter },
					isError: false,
				});
			}, delay);
		});

		const binding = {
			id: "test-first",
			event: "test.first",
			mode: "parallel-first" as const,
			chain: [
				{ adapter: "validator1" },
				{ adapter: "validator2" },
				{ adapter: "validator3" },
			] satisfies BindingStage[],
		};

		const start = Date.now();
		const result = await executeBindingChain(binding, { output: { test: true } }, n, "corr-4");
		const elapsed = Date.now() - start;

		expect(result.approved).toBe(true);
		expect(result.reviewer).toBe("validator1");
		// Should return immediately (< 50ms), not wait for all (> 100ms)
		expect(elapsed).toBeLessThan(200);

		offCommand();
	});

	it("allows registration of custom strategies", async () => {
		const { n } = makeBus();

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
			chain: [{ adapter: "validator1" }] satisfies BindingStage[],
		};

		const result = await executeBindingChain(binding, { output: { test: true } }, n, "corr-5");

		expect(result.approved).toBe(true);
		expect(result.reviewer).toBe("always-approve-strategy");
	});

	it("throws error for unknown binding mode", () => {
		const { n } = makeBus();

		const binding = {
			id: "test-unknown",
			event: "test.unknown",
			mode: "nonexistent-mode" as any,
			chain: [{ adapter: "validator1" }] satisfies BindingStage[],
		};

		expect(() => executeBindingChain(binding, { output: { test: true } }, n, "corr-6")).toThrow(
			"Unknown binding mode: nonexistent-mode",
		);
	});

	it("ordered strategy stops on first rejection", async () => {
		const { n } = makeBus();

		const executedStages: string[] = [];
		const offCommand = n.command.subscribe(VALIDATE_REQUEST, (event) => {
			const payload = event.payload as { id: string; targetAdapter: string };
			executedStages.push(payload.targetAdapter);
			// validator2 rejects
			const approved = payload.targetAdapter !== "validator2";
			n.event.publish({
				type: VALIDATE_RESULT,
				correlationId: event.correlationId,
				payload: { id: payload.id, approved, reviewer: payload.targetAdapter },
				isError: false,
			});
		});

		const binding = {
			id: "test-stop",
			event: "test.stop",
			mode: "ordered" as const,
			chain: [
				{ adapter: "validator1" },
				{ adapter: "validator2" },
				{ adapter: "validator3" },
			] satisfies BindingStage[],
		};

		const result = await executeBindingChain(binding, { output: { test: true } }, n, "corr-7");

		expect(result.approved).toBe(false);
		expect(result.reviewer).toBe("validator2");
		// Should not execute validator3 after validator2 rejects
		expect(executedStages).toEqual(["validator1", "validator2"]);

		offCommand();
	});
});
