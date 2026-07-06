import { z } from "zod";

/**
 *
 */
export interface Contract<T extends z.ZodTypeAny> {
	readonly schema: T;
	readonly intent: string;
	readonly validator?: "human" | "agent" | "machine" | string;
}

/**
 *
 */
export function defineContract<T extends z.ZodTypeAny>(
	intent: string,
	schema: T,
	validator?: Contract<T>["validator"],
): Contract<T> {
	return { intent, schema, ...(validator ? { validator } : {}) };
}

// ---------------------------------------------------------------------------
// Nested sub-contracts — sections of the root PlannerContract.
// ---------------------------------------------------------------------------

const MetadataSchema = z.object({
	title: z.string().min(1).describe("Short title for this planning session"),
	request: z.string().min(1).describe("The original user request, restated verbatim"),
});

const IntentSchema = z.object({
	intent: z.string().min(1).describe("What needs to be done, stated unambiguously"),
	scope: z.string().min(1).describe("What is included in this work"),
	constraints: z.array(z.string()).describe("Known constraints or requirements"),
});

const GoalSchema = z.object({
	goal: z.string().min(1).describe("A single concrete, measurable goal"),
	successCriteria: z.array(z.string()).min(1).describe("How to verify the goal is achieved"),
	outOfScope: z.array(z.string()).describe("What is explicitly excluded"),
});

const ImplementSchema = z.object({
	steps: z
		.array(z.object({ action: z.string().min(1), rationale: z.string().min(1) }))
		.min(1)
		.describe("Ordered implementation steps"),
	risks: z.array(z.string()).describe("Known risks or unknowns"),
	firstAction: z.string().min(1).describe("The single next action to take right now"),
});

const ExitSchema = z.object({
	summary: z.string().min(1).describe("One-paragraph summary of the complete plan"),
	confidence: z.enum(["low", "medium", "high"]).describe("Agent's confidence in the plan given available information"),
});

// ---------------------------------------------------------------------------
// Root contract — the agent fills all nested sections, then exits.
// ---------------------------------------------------------------------------

const PlannerSchema = z.object({
	metadata: MetadataSchema,
	intent: IntentSchema,
	goal: GoalSchema,
	implement: ImplementSchema,
	exit: ExitSchema,
});

export const PlannerContract = defineContract(
	"Produce a complete planning document. Fill metadata, intent, goal, implement, then exit.",
	PlannerSchema,
);

/**
 *
 */
export type PlannerOutput = z.infer<typeof PlannerSchema>;
/**
 *
 */
export type MetadataOutput = z.infer<typeof MetadataSchema>;
/**
 *
 */
export type IntentOutput = z.infer<typeof IntentSchema>;
/**
 *
 */
export type GoalOutput = z.infer<typeof GoalSchema>;
/**
 *
 */
export type ImplementOutput = z.infer<typeof ImplementSchema>;
/**
 *
 */
export type ExitOutput = z.infer<typeof ExitSchema>;

// ---------------------------------------------------------------------------
// Legacy flat contracts kept for backward compatibility.
// ---------------------------------------------------------------------------

export const IntentContract = defineContract(
	"Clarify the user's request into an unambiguous intent statement.",
	IntentSchema,
);

export const GoalContract = defineContract("Translate the intent into a concrete, measurable goal.", GoalSchema);

export const ImplementContract = defineContract(
	"Produce an ordered implementation plan for the goal.",
	ImplementSchema,
);
