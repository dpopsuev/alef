import {
	type Contract,
	createContractTool,
	createQuestionTool,
	GoalContract,
	ImplementContract,
	IntentContract,
	type StationDef,
	type StationResult,
	type StationRunner,
} from "@dpopsuev/alef-adapter-workflow";
import type { Organ } from "@dpopsuev/alef-kernel";
import type { Api, Model } from "@dpopsuev/alef-llm";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import { Agent, AgentController } from "@dpopsuev/alef-runtime";
import type { z } from "zod";

const PRESET_CONTRACTS: Record<string, Contract<z.ZodTypeAny>> = {
	intent: IntentContract,
	goal: GoalContract,
	implement: ImplementContract,
};

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

export class ImplStationRunner implements StationRunner {
	constructor(
		private readonly model: Model<Api>,
		private readonly domainOrgans: Organ[] = [],
		private readonly onQuestion?: (q: string) => Promise<string>,
	) {}

	async run(station: StationDef, artifact: unknown): Promise<StationResult> {
		const contract = PRESET_CONTRACTS[station.contract];
		if (!contract) {
			return { status: "error", output: undefined, questions: [] };
		}

		let submittedOutput: unknown;
		const questions: Array<{ question: string; answer: string }> = [];

		const contractOrgan = createContractTool(contract, (data) => {
			submittedOutput = data;
		});

		const defaultOnQuestion = (q: string): Promise<string> => {
			questions.push({ question: q, answer: "[awaiting user input]" });
			return Promise.resolve("[awaiting user input]");
		};

		const questionOrgan = createQuestionTool(this.onQuestion ?? defaultOnQuestion, questions);

		const agent = new Agent();
		const llm = createAgentLoop({
			model: this.model,
			systemPrompt: buildStationPrompt(station, contract),
		});

		agent.load(llm).load(contractOrgan).load(questionOrgan);
		for (const organ of this.domainOrgans) agent.load(organ);

		const controller = new AgentController(agent);
		await agent.ready();

		const artifactText = artifact !== undefined ? `\n\nIncoming artifact:\n${JSON.stringify(artifact, null, 2)}` : "";

		await controller.send(`Begin station "${station.name}".${artifactText}`, "human", station.timeoutMs ?? 180_000);

		agent.dispose();

		if (submittedOutput !== undefined) {
			return { status: "fulfilled", output: submittedOutput, questions };
		}
		return { status: "budget_exhausted", output: undefined, questions };
	}
}
