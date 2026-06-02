import { z } from "zod";

export interface Contract<T extends z.ZodTypeAny> {
	readonly schema: T;
	readonly intent: string;
}

export function defineContract<T extends z.ZodTypeAny>(intent: string, schema: T): Contract<T> {
	return { intent, schema };
}

export const IntentContract = defineContract(
	"Clarify the user's request into an unambiguous intent statement.",
	z.object({
		intent: z.string().describe("What needs to be done, stated precisely"),
		scope: z.string().describe("What is in scope for this work"),
		constraints: z.array(z.string()).describe("Known constraints or requirements"),
	}),
);

export const GoalContract = defineContract(
	"Translate the intent into a concrete, measurable goal.",
	z.object({
		goal: z.string().describe("A single concrete goal statement"),
		successCriteria: z.array(z.string()).min(1).describe("How to verify the goal is achieved"),
		outOfScope: z.array(z.string()).describe("What is explicitly not being done"),
	}),
);

export const ImplementContract = defineContract(
	"Produce an ordered implementation plan for the goal.",
	z.object({
		steps: z
			.array(z.object({ action: z.string(), rationale: z.string() }))
			.min(1)
			.describe("Ordered implementation steps"),
		risks: z.array(z.string()).describe("Known risks or unknowns"),
		firstAction: z.string().describe("The single next concrete action to take right now"),
	}),
);

export type IntentOutput = z.infer<typeof IntentContract.schema>;
export type GoalOutput = z.infer<typeof GoalContract.schema>;
export type ImplementOutput = z.infer<typeof ImplementContract.schema>;
