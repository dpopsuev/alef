import { z } from "zod";

export const StationDefSchema = z.object({
	name: z.string(),
	contract: z.enum(["intent", "goal", "implement"]).describe("Preset contract name"),
	blueprint: z.string().optional().describe("Agent blueprint name from manifest"),
	timeoutMs: z.number().optional(),
	validator: z.enum(["human", "agent", "machine"]).optional().describe("Who evaluates the contract output"),
});

export const EdgeDefSchema = z.object({
	from: z.string(),
	to: z.string(),
	when: z.string().optional().describe("JSONPath-style condition on the artifact, e.g. 'status == \"approved\"'"),
});

export const WorkflowDefSchema = z.object({
	name: z.string(),
	version: z.string().optional(),
	start: z.string(),
	done: z.string(),
	stations: z.array(StationDefSchema).min(1),
	edges: z.array(EdgeDefSchema),
});

export type StationDef = z.infer<typeof StationDefSchema>;
export type EdgeDef = z.infer<typeof EdgeDefSchema>;
export type WorkflowDef = z.infer<typeof WorkflowDefSchema>;
