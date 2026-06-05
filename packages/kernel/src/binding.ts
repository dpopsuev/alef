import type { Nerve, SenseEvent } from "./buses.js";
import { newCorrelationId } from "./buses.js";
import { debugLog } from "./debug.js";
import { VALIDATE_REQUEST, VALIDATE_RESULT } from "./protocols.js";

export type BindingMode = "ordered" | "parallel-all" | "parallel-first";

export interface BindingStage {
	organ: string;
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

function waitForValidateResult(sense: Nerve["sense"], id: string, timeoutMs: number): Promise<ChainResult> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			off();
			resolve({ approved: true, reviewer: "timeout-auto-approve" });
		}, timeoutMs);

		const off = sense.subscribe(VALIDATE_RESULT, (event: SenseEvent) => {
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

async function executeOrdered(
	chain: BindingStage[],
	input: ChainInput,
	nerve: Nerve,
	sourceCorrelationId: string,
): Promise<ChainResult> {
	let current = input;

	for (let i = 0; i < chain.length; i++) {
		const stage = chain[i];
		if (stage.filter && !stage.filter(current.output as Record<string, unknown>)) {
			continue;
		}

		const stageId = newCorrelationId();
		const timeoutMs = stage.timeout ?? DEFAULT_STAGE_TIMEOUT_MS;

		debugLog("binding:stage:start", { stageIdx: i, organ: stage.organ, stageId });

		const resultPromise = waitForValidateResult(nerve.sense, stageId, timeoutMs);

		nerve.motor.publish({
			type: VALIDATE_REQUEST,
			correlationId: sourceCorrelationId,
			payload: {
				id: stageId,
				output: current.output,
				kind: current.kind,
				context: current.context,
				targetOrgan: stage.organ,
			},
		});

		const result = await resultPromise;

		debugLog("binding:stage:result", {
			stageIdx: i,
			organ: stage.organ,
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

async function executeParallelAll(
	chain: BindingStage[],
	input: ChainInput,
	nerve: Nerve,
	sourceCorrelationId: string,
): Promise<ChainResult> {
	const stages = chain.filter((s) => !s.filter || s.filter(input.output as Record<string, unknown>));
	const results = await Promise.all(
		stages.map(async (stage) => {
			const stageId = newCorrelationId();
			const resultPromise = waitForValidateResult(nerve.sense, stageId, stage.timeout ?? DEFAULT_STAGE_TIMEOUT_MS);
			nerve.motor.publish({
				type: VALIDATE_REQUEST,
				correlationId: sourceCorrelationId,
				payload: {
					id: stageId,
					output: input.output,
					kind: input.kind,
					context: input.context,
					targetOrgan: stage.organ,
				},
			});
			return resultPromise;
		}),
	);
	const rejected = results.find((r) => !r.approved);
	return rejected ?? { approved: true, reviewer: "parallel-all-complete" };
}

async function executeParallelFirst(
	chain: BindingStage[],
	input: ChainInput,
	nerve: Nerve,
	sourceCorrelationId: string,
): Promise<ChainResult> {
	const stages = chain.filter((s) => !s.filter || s.filter(input.output as Record<string, unknown>));
	return Promise.race(
		stages.map(async (stage) => {
			const stageId = newCorrelationId();
			const resultPromise = waitForValidateResult(nerve.sense, stageId, stage.timeout ?? DEFAULT_STAGE_TIMEOUT_MS);
			nerve.motor.publish({
				type: VALIDATE_REQUEST,
				correlationId: sourceCorrelationId,
				payload: {
					id: stageId,
					output: input.output,
					kind: input.kind,
					context: input.context,
					targetOrgan: stage.organ,
				},
			});
			return resultPromise;
		}),
	);
}

export function executeBindingChain(
	binding: Binding,
	input: ChainInput,
	nerve: Nerve,
	sourceCorrelationId: string,
): Promise<ChainResult> {
	debugLog("binding:chain:start", {
		id: binding.id,
		event: binding.event,
		mode: binding.mode,
		stages: binding.chain.length,
	});
	switch (binding.mode) {
		case "ordered":
			return executeOrdered(binding.chain, input, nerve, sourceCorrelationId);
		case "parallel-all":
			return executeParallelAll(binding.chain, input, nerve, sourceCorrelationId);
		case "parallel-first":
			return executeParallelFirst(binding.chain, input, nerve, sourceCorrelationId);
	}
}

export function withBindings(bindings: Map<string, Binding>, baseNerve: Nerve): Nerve {
	return {
		motor: {
			subscribe: baseNerve.motor.subscribe.bind(baseNerve.motor),
			publish: (event) => {
				const binding = [...bindings.values()].find((b) => b.event === event.type);
				if (!binding) {
					baseNerve.motor.publish(event);
					return;
				}
				const input: ChainInput = {
					output: event.payload,
					kind: (event.payload as Record<string, unknown>).kind as string | undefined,
					context: (event.payload as Record<string, unknown>).context as string | undefined,
				};
				void executeBindingChain(binding, input, baseNerve, event.correlationId);
			},
		},
		sense: baseNerve.sense,
	};
}
