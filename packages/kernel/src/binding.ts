import type { Bus, EventMessage } from "./buses.js";
import { makeBus, newCorrelationId } from "./buses.js";
import { traceEvent } from "./debug.js";
import { VALIDATE_REQUEST, VALIDATE_RESULT } from "./protocols.js";

export type BindingMode = "ordered" | "parallel-all" | "parallel-first";

export interface BindingStage {
	adapter: string;
	filter?: (payload: Record<string, unknown>) => boolean;
	timeout?: number;
}

export interface Binding {
	id: string;
	event: string;
	chain: BindingStage[];
	mode: BindingMode;
}

interface ChainInput {
	output: unknown;
	context?: string;
	kind?: string;
}

interface ChainResult {
	approved: boolean;
	feedback?: string;
	evidence?: string;
	reviewer: string;
}

const DEFAULT_STAGE_TIMEOUT_MS = 30_000;

function publishValidateRequest(
	bus: Bus,
	stage: BindingStage,
	input: ChainInput,
	sourceCorrelationId: string,
): { stageId: string; result: Promise<ChainResult> } {
	const stageId = newCorrelationId();
	const result = waitForValidateResult(bus.event, stageId, stage.timeout ?? DEFAULT_STAGE_TIMEOUT_MS);
	bus.command.publish({
		type: VALIDATE_REQUEST,
		correlationId: sourceCorrelationId,
		payload: {
			id: stageId,
			output: input.output,
			kind: input.kind,
			context: input.context,
			targetAdapter: stage.adapter,
		},
	});
	return { stageId, result };
}

function waitForValidateResult(eventChannel: Bus["event"], id: string, timeoutMs: number): Promise<ChainResult> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			off();
			resolve({ approved: true, reviewer: "timeout-auto-approve" });
		}, timeoutMs);

		const off = eventChannel.subscribe(VALIDATE_RESULT, (event: EventMessage) => {
			const p = event.payload as {
				id?: string;
				approved?: boolean;
				feedback?: string;
				evidence?: string;
				reviewer?: string;
			};
			if (p.id !== id) return;
			clearTimeout(timer);
			off();
			resolve({
				approved: p.approved ?? false,
				feedback: p.feedback,
				evidence: p.evidence,
				reviewer: p.reviewer ?? "unknown",
			});
		});
	});
}

/**
 * Strategy interface for binding chain execution.
 * Implementations define how stages are executed (ordered, parallel, etc).
 */
interface BindingExecutionStrategy {
	execute(chain: BindingStage[], input: ChainInput, bus: Bus, sourceCorrelationId: string): Promise<ChainResult>;
}

/**
 * Executes stages sequentially. Stops on first rejection.
 * Passes feedback from each stage to the next via _feedback field.
 */
class OrderedStrategy implements BindingExecutionStrategy {
	async execute(
		chain: BindingStage[],
		input: ChainInput,
		bus: Bus,
		sourceCorrelationId: string,
	): Promise<ChainResult> {
		let current = input;

		for (let i = 0; i < chain.length; i++) {
			const stage = chain[i];
			if (stage.filter && !stage.filter(current.output as Record<string, unknown>)) {
				continue;
			}

			const { stageId, result: resultPromise } = publishValidateRequest(bus, stage, current, sourceCorrelationId);
			traceEvent("binding:stage:start", { stageIdx: i, adapter: stage.adapter, stageId });

			const result = await resultPromise;

			traceEvent("binding:stage:result", {
				stageIdx: i,
				adapter: stage.adapter,
				approved: result.approved,
				reviewer: result.reviewer,
			});

			if (!result.approved) return result;

			current = {
				...current,
				output: { ...(current.output as Record<string, unknown>), _feedback: result.feedback },
			};
		}

		return { approved: true, reviewer: "chain-complete" };
	}
}

/**
 * Executes all stages in parallel. Waits for all. Rejects if any stage rejects.
 */
class ParallelAllStrategy implements BindingExecutionStrategy {
	async execute(
		chain: BindingStage[],
		input: ChainInput,
		bus: Bus,
		sourceCorrelationId: string,
	): Promise<ChainResult> {
		const stages = chain.filter((s) => !s.filter || s.filter(input.output as Record<string, unknown>));
		const results = await Promise.all(
			stages.map((stage) => publishValidateRequest(bus, stage, input, sourceCorrelationId).result),
		);
		const rejected = results.find((r) => !r.approved);
		return rejected ?? { approved: true, reviewer: "parallel-all-complete" };
	}
}

/**
 * Executes all stages in parallel. Returns the first result (approved or rejected).
 */
class ParallelFirstStrategy implements BindingExecutionStrategy {
	async execute(
		chain: BindingStage[],
		input: ChainInput,
		bus: Bus,
		sourceCorrelationId: string,
	): Promise<ChainResult> {
		const stages = chain.filter((s) => !s.filter || s.filter(input.output as Record<string, unknown>));
		return Promise.race(stages.map((stage) => publishValidateRequest(bus, stage, input, sourceCorrelationId).result));
	}
}

/**
 * Registry of binding execution strategies.
 * Extensible: new modes can be added without modifying executeBindingChain.
 */
const strategies: Record<BindingMode, BindingExecutionStrategy> = {
	ordered: new OrderedStrategy(),
	"parallel-all": new ParallelAllStrategy(),
	"parallel-first": new ParallelFirstStrategy(),
};

/**
 * Register a custom binding execution strategy.
 * Allows extension of binding modes without modifying core code.
 */
export function registerBindingStrategy(mode: string, strategy: BindingExecutionStrategy): void {
	(strategies as Record<string, BindingExecutionStrategy>)[mode] = strategy;
}

export function executeBindingChain(
	binding: Binding,
	input: ChainInput,
	bus: Bus,
	sourceCorrelationId: string,
): Promise<ChainResult> {
	traceEvent("binding:chain:start", {
		id: binding.id,
		event: binding.event,
		mode: binding.mode,
		stages: binding.chain.length,
	});

	const strategy = strategies[binding.mode];
	if (!strategy) {
		throw new Error(`Unknown binding mode: ${binding.mode}`);
	}

	return strategy.execute(binding.chain, input, bus, sourceCorrelationId);
}

export function withBindings(bindings: Map<string, Binding>, baseBus: Bus): Bus {
	return makeBus(
		{
			subscribe: baseBus.command.subscribe.bind(baseBus.command),
			publish: (event) => {
				const binding = [...bindings.values()].find((b) => b.event === event.type);
				if (!binding) {
					baseBus.command.publish(event);
					return;
				}
				const payload = event.payload;
				const input: ChainInput = {
					output: event.payload,
					kind: typeof payload.kind === "string" ? payload.kind : undefined,
					context: typeof payload.context === "string" ? payload.context : undefined,
				};
				void executeBindingChain(binding, input, baseBus, event.correlationId);
			},
		},
		baseBus.event,
		baseBus.notification,
		() => baseBus.pulse(),
	);
}

// Export the interface for external strategy implementations
export type { BindingExecutionStrategy };
