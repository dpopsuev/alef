export const VALIDATE_REQUEST = "validate.required";
export const VALIDATE_RESULT = "validate.result";

export interface ValidateRequest {
	id: string;
	output: unknown;
	kind?: string;
	context?: string;
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
