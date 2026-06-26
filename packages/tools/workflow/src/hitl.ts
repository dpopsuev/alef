import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { type ValidateRequest, VALIDATE_REQUEST, VALIDATE_RESULT } from "@dpopsuev/alef-kernel/bus";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { traceEvent } from "@dpopsuev/alef-kernel/log";

export interface HitlEvaluateInput {
	output: unknown;
	context?: string;
	kind?: string;
}

export interface HitlEvaluateResult {
	approved: boolean;
	feedback?: string;
}

export type OnEvaluate = (input: HitlEvaluateInput) => Promise<HitlEvaluateResult>;

export interface HitlAdapterOptions {
	name?: string;
	onEvaluate: OnEvaluate;
}

export function createHitlAdapter(opts: HitlAdapterOptions): Adapter {
	const adapterName = opts.name ?? "hitl";

	return {
		name: adapterName,
		tools: [],
		description: "Human-in-the-Loop evaluator — pauses to ask a human for approval.",
		directives: ["When a contract requires human review, the human approves or rejects with optional feedback."],
		subscriptions: {
			command: [VALIDATE_REQUEST],
			event: [],
			notification: [],
		},
		sources: [],
		mount(bus: Bus): () => void {
			return bus.command.subscribe(VALIDATE_REQUEST, (event) => {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- VALIDATE_REQUEST payload shape enforced by bus protocol
				const p = event.payload as unknown as ValidateRequest;

				if (p.targetAdapter && p.targetAdapter !== adapterName) return;
				if (p.kind && p.kind !== "human" && p.targetAdapter !== adapterName) return;

				traceEvent("hitl:evaluate:start", { id: p.id, context: p.context, kind: p.kind });

				void opts.onEvaluate({ output: p.output, context: p.context, kind: p.kind }).then((result) => {
					traceEvent("hitl:evaluate:result", { id: p.id, approved: result.approved });
					bus.event.publish({
						type: VALIDATE_RESULT,
						correlationId: event.correlationId,
						payload: {
							id: p.id,
							approved: result.approved,
							feedback: result.feedback,
							reviewer: "human",
						},
						isError: false,
					});
				});
			});
		},
	};
}
