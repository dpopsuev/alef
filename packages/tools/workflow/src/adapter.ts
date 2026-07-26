import type { BaseAdapterOptions, CommandHandlerCtx } from "@dpopsuev/alef-kernel/adapter";
import {
	defineAdapter,
	tool,
	typedAction,
} from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import { z } from "zod";
import type { Contract } from "./contract.js";
import type { StationDef, WorkflowDef } from "./schema.js";

/**
 *
 */
export type StationStatus = "fulfilled" | "budget_exhausted" | "error";

/**
 *
 */
export interface StationResult {
	status: StationStatus;
	output: unknown;
	questions: Array<{ question: string; answer: string }>;
}

/**
 *
 */
export interface StationRunner {
	run(station: StationDef, artifact: unknown): Promise<StationResult>;
}

/**
 *
 */
export interface WorkflowAdapterOptions extends BaseAdapterOptions {
	def: WorkflowDef;
	runner: StationRunner;
}

/**
 *
 */
export function createWorkflowAdapter(opts: WorkflowAdapterOptions) {
	let bus: Bus | null = null;
	const emitSignal = (type: string, payload: Record<string, unknown>) =>
		bus?.notification.publish({ type, payload, correlationId: "" });

	const WORKFLOW_RUN_TOOL = tool(
		"workflow.run",
		"Execute a named station in the workflow pipeline and return the fulfilled artifact.",
		z.object({
			station: z.string().min(1).describe("Station name from the workflow definition"),
			artifact: z.unknown().optional().describe("Input artifact from a previous station"),
		}),
	);

	/** Execute a named station in the workflow pipeline and return the fulfilled artifact. */
	async function handleWorkflowRun(
		ctx: CommandHandlerCtx<z.infer<typeof WORKFLOW_RUN_TOOL.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const stationName = ctx.payload.station;
		const artifact = ctx.payload.artifact;

		const stationDef = opts.def.stations.find((s) => s.name === stationName);
		if (!stationDef) {
			const names = opts.def.stations.map((s) => s.name).join(", ");
			return withDisplay(
				{ error: `Station '${stationName}' not found. Available: ${names}` },
				{ text: `Station '${stationName}' not found`, mimeType: "text/plain" },
			);
		}

		emitSignal("workflow.intent", { text: `station: ${stationName}` });
		const result = await opts.runner.run(stationDef, artifact);
		emitSignal("workflow.intent", { text: "" });
		return withDisplay(
			{ status: result.status, output: result.output, questions: result.questions },
			{ text: `Station '${stationName}': ${result.status}`, mimeType: "text/plain" },
		);
	}

	return defineAdapter(
		"workflow",
		{
			command: {
				"workflow.run": typedAction(WORKFLOW_RUN_TOOL, handleWorkflowRun),
			},
		},
		{
			description: `Workflow adapter: ${opts.def.name} (${opts.def.stations.map((s) => s.name).join(" → ")})`,
			onMount: (b: Bus) => {
				bus = b;
			},
			contributions: {
				ui: {
					signals: {
						"workflow.intent": (payload, ui) => {
							ui.setIntent(typeof payload.text === "string" ? payload.text : "");
						},
					},
				},
			},
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

/**
 *
 */
export function createContractTool<T extends z.ZodTypeAny>(
	contract: Contract<T>,
	onSubmit: (data: z.infer<T>) => void,
	onEvaluate?: (input: { output: z.infer<T>; context: string; kind: string }) => Promise<{ approved: boolean; feedback?: string }>,
) {
	const SUBMIT_TOOL = tool(
		"contract.submit",
		`Submit completed work for validation. ${contract.intent}`,
		z.object({ data: z.record(z.string().min(1), z.unknown()) }),
	);

	/** Validate agent output against the contract schema, optionally routing through an evaluator. */
	async function handleContractSubmit(
		ctx: CommandHandlerCtx<z.infer<typeof SUBMIT_TOOL.inputSchema>>,
	): Promise<Record<string, unknown>> {
		traceEvent("contract:submit", {
			correlationId: ctx.correlationId,
			hasValidator: !!contract.validator,
		});
		const schemaResult = contract.schema.safeParse(ctx.payload.data);
		if (!schemaResult.success) {
			const errors = schemaResult.error.issues
				.map((i: z.ZodIssue) => `${i.path.join(".") || "(root)"}: ${i.message}`)
				.join("; ");
			return withDisplay(
				{ success: false, errors },
				{ text: `Contract rejected: ${errors}`, mimeType: "text/plain" },
			);
		}

		const validated = schemaResult.data;

		if (!contract.validator) {
			onSubmit(validated);
			return withDisplay(
				{ success: true, message: "Contract fulfilled." },
				{ text: "Contract fulfilled", mimeType: "text/plain" },
			);
		}

		if (!onEvaluate) {
			return withDisplay(
				{ success: false, errors: `Contract requires ${contract.validator} evaluation, but no evaluator is configured.` },
				{ text: `Contract rejected: ${contract.validator} evaluator unavailable`, mimeType: "text/plain" },
			);
		}
		const result = await onEvaluate({ output: validated, context: contract.intent, kind: contract.validator });
		traceEvent("contract:result", { correlationId: ctx.correlationId, approved: result.approved });
		if (!result.approved) {
			return withDisplay(
				{ success: false, errors: result.feedback ?? "Rejected by evaluator." },
				{ text: `Contract rejected: ${result.feedback ?? "Rejected by evaluator."}`, mimeType: "text/plain" },
			);
		}
		onSubmit(validated);
		return withDisplay(
			{ success: true, message: "Contract fulfilled." },
			{ text: "Contract fulfilled", mimeType: "text/plain" },
		);
	}

	return defineAdapter(
		"contract",
		{
			command: {
				"contract.submit": typedAction(SUBMIT_TOOL, handleContractSubmit),
			},
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

/**
 *
 */
export function createQuestionTool(
	onQuestion: (question: string) => Promise<string>,
	log: Array<{ question: string; answer: string }>,
) {
	const QUESTION_TOOL = tool(
		"question.ask",
		"Ask the user a clarifying question and receive their answer before proceeding.",
		z.object({ question: z.string().min(1) }),
	);

	/** Ask the user a clarifying question and return their answer. */
	async function handleQuestionAsk(
		ctx: CommandHandlerCtx<z.infer<typeof QUESTION_TOOL.inputSchema>>,
	): Promise<Record<string, unknown>> {
		const question = ctx.payload.question;
		const answer = await onQuestion(question);
		log.push({ question, answer });
		return withDisplay({ answer }, { text: `Q: ${question}\nA: ${answer}`, mimeType: "text/plain" });
	}

	return defineAdapter(
		"question",
		{
			command: {
				"question.ask": typedAction(QUESTION_TOOL, handleQuestionAsk),
			},
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
