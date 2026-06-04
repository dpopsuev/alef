/**
 * Bus-level protocol conventions.
 *
 * Shared event type names and payload contracts for multi-organ protocols.
 * Any organ that participates in these protocols imports from here.
 * Not part of the bus mechanics (see buses.ts) — these are agreements
 * layered on top of the transport, like HTTP headers on top of TCP.
 */

// ---------------------------------------------------------------------------
// Validation protocol
// ---------------------------------------------------------------------------

/** Motor event type: request validation of an output by a validator organ. */
export const VALIDATE_REQUEST = "validate.required";

/** Sense event type: validation organ responds with approval/rejection. */
export const VALIDATE_RESULT = "validate.result";

export interface ValidateRequest {
	id: string;
	output: unknown;
	kind?: string;
	context?: string;
	targetOrgan?: string;
}

export interface ValidateResult {
	id: string;
	approved: boolean;
	feedback?: string;
	evidence?: string;
	reviewer: string;
}

export interface Validator {
	validate(output: unknown): Promise<ValidateResult>;
}

export interface Evaluator {
	evaluate(output: unknown): Promise<ValidateResult>;
}
