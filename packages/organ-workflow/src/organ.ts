import type { BaseOrganOptions } from "@dpopsuev/alef-spine";
import { defineOrgan, tool, typedAction } from "@dpopsuev/alef-spine";
import { z } from "zod";
import type { Contract } from "./contract.js";
import type { StationDef, WorkflowDef } from "./schema.js";

export type StationStatus = "fulfilled" | "budget_exhausted" | "error";

export interface StationResult {
	status: StationStatus;
	output: unknown;
	questions: Array<{ question: string; answer: string }>;
}

export interface StationRunner {
	run(station: StationDef, artifact: unknown): Promise<StationResult>;
}

export interface WorkflowOrganOptions extends BaseOrganOptions {
	def: WorkflowDef;
	runner: StationRunner;
}

export function createWorkflowOrgan(opts: WorkflowOrganOptions) {
	const WORKFLOW_RUN_TOOL = tool(
		"workflow.run",
		"Execute a named station in the workflow pipeline and return the fulfilled artifact.",
		z.object({
			station: z.string().describe("Station name from the workflow definition"),
			artifact: z.unknown().optional().describe("Input artifact from a previous station"),
		}),
	);

	return defineOrgan(
		"workflow",
		{
			"motor/workflow.run": typedAction(WORKFLOW_RUN_TOOL, async (ctx) => {
				const stationName = ctx.payload.station as string;
				const artifact = ctx.payload.artifact;

				const stationDef = opts.def.stations.find((s) => s.name === stationName);
				if (!stationDef) {
					const names = opts.def.stations.map((s) => s.name).join(", ");
					return { error: `Station '${stationName}' not found. Available: ${names}` };
				}

				const result = await opts.runner.run(stationDef, artifact);
				return { status: result.status, output: result.output, questions: result.questions };
			}),
		},
		{
			description: `Workflow organ: ${opts.def.name} (${opts.def.stations.map((s) => s.name).join(" → ")})`,
			directives: [
				`You are executing the "${opts.def.name}" workflow.`,
				`Stations in order: ${opts.def.stations.map((s) => s.name).join(" → ")}.`,
				`Use workflow.run(station, artifact) to execute each station.`,
				`Pass the output of each station as the artifact to the next.`,
				`Start at station "${opts.def.start}" and finish at "${opts.def.done}".`,
			],
			...opts,
		},
	);
}

export function createContractTool<T extends z.ZodTypeAny>(
	contract: Contract<T>,
	onSubmit: (data: z.infer<T>) => void,
) {
	const SUBMIT_TOOL = tool(
		"contract.submit",
		`Submit completed work for validation. ${contract.intent}`,
		z.object({ data: z.record(z.string(), z.unknown()) }),
	);

	return defineOrgan(
		"contract",
		{
			"motor/contract.submit": typedAction(SUBMIT_TOOL, async (ctx) => {
				const result = contract.schema.safeParse(ctx.payload.data);
				if (result.success) {
					onSubmit(result.data);
					return { success: true, message: "Contract fulfilled." };
				}
				const errors = result.error.issues
					.map((i: z.ZodIssue) => `${i.path.join(".") || "(root)"}: ${i.message}`)
					.join("; ");
				return { success: false, errors };
			}),
		},
		{
			description: "Contract submission gate — validates agent output against the station exit schema.",
			directives: [
				"Call contract.submit(data) when you have gathered sufficient information to satisfy the station goal.",
				"If validation fails, read the error carefully and resubmit with corrected data.",
			],
		},
	);
}

export function createQuestionTool(
	onQuestion: (question: string) => Promise<string>,
	log: Array<{ question: string; answer: string }>,
) {
	const QUESTION_TOOL = tool(
		"question.ask",
		"Ask the user a clarifying question and receive their answer before proceeding.",
		z.object({ question: z.string() }),
	);

	return defineOrgan(
		"question",
		{
			"motor/question.ask": typedAction(QUESTION_TOOL, async (ctx) => {
				const answer = await onQuestion(ctx.payload.question as string);
				log.push({ question: ctx.payload.question as string, answer });
				return { answer };
			}),
		},
		{
			description: "User clarification gate — pauses the agent to ask the user a question.",
			directives: [
				"Call question.ask(question) before submitting the contract if you are uncertain about the user's intent.",
				"The user's answer is returned as the tool result — incorporate it before calling contract.submit.",
			],
		},
	);
}
