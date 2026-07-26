import { createAgentSession } from "@dpopsuev/alef-agent/create-agent-session";
import type { Api, Model } from "@dpopsuev/alef-ai/types";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
// eslint-disable-next-line no-restricted-imports -- workflow contracts belong in core; refactor pending
import { type Contract, createContractTool, createQuestionTool, GoalContract, ImplementContract, IntentContract, type StationDef, type StationResult, type StationRunner } from "@dpopsuev/alef-tool-workflow";
import type { z } from "zod";

const STATION_TIMEOUT_MS = 180_000;

const PRESET_CONTRACTS: Record<string, Contract<z.ZodTypeAny>> = {
	intent: IntentContract,
	goal: GoalContract,
	implement: ImplementContract,
};

/**
 *
 */
function buildStationPrompt(station: StationDef, contract: Contract<z.ZodTypeAny>): string {
	return [
		`You are the "${station.name}" station in a workflow pipeline.`,
		``,
		`Your goal: ${contract.intent}`,
		``,
		`Tools available to you:`,
		`  contract.submit(data) — submit when you have satisfied the goal.`,
		`    Validation errors are returned so you can correct and resubmit.`,
		`  question.ask(question) — ask the user a clarifying question.`,
		`    Use this before submitting if you are uncertain about their intent.`,
		``,
		`Required output schema: ${JSON.stringify(contract.schema._def)}`,
		``,
		`Use your available domain tools to gather information, then submit the contract.`,
	].join("\n");
}

/**
 *
 */
export class ImplStationRunner implements StationRunner {
	constructor(
		private readonly model: Model<Api>,
		private readonly domainAdapters: Adapter[] = [],
		private readonly onQuestion?: (q: string) => Promise<string>,
	) {}

	async run(station: StationDef, artifact: unknown): Promise<StationResult> {
		const contract = PRESET_CONTRACTS[station.contract];
		if (!contract) {
			return { status: "error", output: undefined, questions: [] };
		}

		let submittedOutput: unknown;
		const questions: Array<{ question: string; answer: string }> = [];

		const contractAdapter = createContractTool(contract, (data) => {
			submittedOutput = data;
		});

		const defaultOnQuestion = (q: string): Promise<string> => {
			questions.push({ question: q, answer: "[awaiting user input]" });
			return Promise.resolve("[awaiting user input]");
		};

		const questionAdapter = createQuestionTool(this.onQuestion ?? defaultOnQuestion, questions);

		const llm = createAgentLoop({
			model: this.model,
			systemPrompt: buildStationPrompt(station, contract),
		});
		const runtime = await createAgentSession({
			cwd: process.cwd(),
			model: this.model,
			adapters: [contractAdapter, questionAdapter, ...this.domainAdapters],
			llmAdapter: llm,
			composeToolShell: false,
		});

		const artifactText = artifact !== undefined ? `\n\nIncoming artifact:\n${JSON.stringify(artifact, null, 2)}` : "";

		await runtime.controller.send(
			`Begin station "${station.name}".${artifactText}`,
			"human",
			station.timeoutMs ?? STATION_TIMEOUT_MS,
		);

		await runtime.dispose();

		if (submittedOutput !== undefined) {
			return { status: "fulfilled", output: submittedOutput, questions };
		}
		return { status: "budget_exhausted", output: undefined, questions };
	}
}
