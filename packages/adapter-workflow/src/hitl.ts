import {
	debugLog,
	type Nerve,
	type Organ,
	VALIDATE_REQUEST,
	VALIDATE_RESULT,
	type ValidateRequest,
} from "@dpopsuev/alef-kernel";

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

export interface HitlOrganOptions {
	name?: string;
	onEvaluate: OnEvaluate;
}

export function createHitlOrgan(opts: HitlOrganOptions): Organ {
	const organName = opts.name ?? "hitl";

	return {
		name: organName,
		tools: [],
		description: "Human-in-the-Loop evaluator — pauses to ask a human for approval.",
		directives: ["When a contract requires human review, the human approves or rejects with optional feedback."],
		subscriptions: {
			motor: [VALIDATE_REQUEST],
			sense: [],
		},
		sources: [],
		mount(nerve: Nerve): () => void {
			return nerve.motor.subscribe(VALIDATE_REQUEST, (event) => {
				const p = event.payload as unknown as ValidateRequest;

				if (p.targetOrgan && p.targetOrgan !== organName) return;
				if (p.kind && p.kind !== "human" && p.targetOrgan !== organName) return;

				debugLog("hitl:evaluate:start", { id: p.id, context: p.context, kind: p.kind });

				void opts.onEvaluate({ output: p.output, context: p.context, kind: p.kind }).then((result) => {
					debugLog("hitl:evaluate:result", { id: p.id, approved: result.approved });
					nerve.sense.publish({
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
