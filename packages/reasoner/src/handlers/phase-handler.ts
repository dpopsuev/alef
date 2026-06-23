import type { EventHandlerCtx } from "@dpopsuev/alef-kernel";
import { debugLog } from "@dpopsuev/alef-kernel";
import type { Message, Tool } from "@dpopsuev/alef-llm";
import type { z } from "zod";

export type PhaseResult =
	| { kind: "continue"; messages?: Message[]; tools?: ToolDefinition[] }
	| { kind: "skip"; reply: string }
	| { kind: "abort" };

type ToolDefinition = { name: string; description: string; inputSchema: z.ZodTypeAny };
type SenseBus = EventHandlerCtx["event"];
type MotorBus = EventHandlerCtx["command"];

const PHASE_PIPELINE_QUIESCENCE_MS = 30;

function parsePhaseResult(payload: Record<string, unknown>): PhaseResult {
	const p = payload as {
		abort?: boolean;
		skip?: boolean;
		reply?: string;
		messages?: Message[];
		tools?: ToolDefinition[];
	};

	if (p.abort) {
		return { kind: "abort" };
	}
	if (p.skip) {
		return { kind: "skip", reply: p.reply ?? "(skipped)" };
	}
	return {
		kind: "continue",
		messages: Array.isArray(p.messages) ? p.messages : undefined,
		tools: Array.isArray(p.tools) ? p.tools : undefined,
	};
}

function mergePhaseResults(stages: PhaseResult[]): PhaseResult | undefined {
	if (stages.length === 0) return undefined;

	// Prioritize abort > skip > continue
	for (const stage of stages) {
		if (stage.kind === "abort") {
			return { kind: "abort" };
		}
	}

	for (let i = stages.length - 1; i >= 0; i--) {
		const stage = stages[i];
		if (stage.kind === "skip") {
			return { kind: "skip", reply: stage.reply };
		}
	}

	// Merge all continue results
	let messages: Message[] | undefined;
	let tools: ToolDefinition[] | undefined;

	for (let i = stages.length - 1; i >= 0; i--) {
		const stage = stages[i];
		if (stage.kind === "continue") {
			if (messages === undefined && stage.messages !== undefined) {
				messages = stage.messages;
			}
			if (tools === undefined && stage.tools !== undefined) {
				tools = stage.tools;
			}
		}
	}

	return { kind: "continue", messages, tools };
}

function waitForPhaseResult(
	sense: SenseBus,
	correlationId: string,
	timeoutMs: number,
): Promise<PhaseResult | undefined> {
	return new Promise((resolve) => {
		const collected: PhaseResult[] = [];
		let quiescenceTimer: ReturnType<typeof setTimeout> | undefined;

		const finish = () => {
			if (quiescenceTimer !== undefined) clearTimeout(quiescenceTimer);
			clearTimeout(deadlineTimer);
			off();
			resolve(mergePhaseResults(collected));
		};

		const deadlineTimer = setTimeout(finish, timeoutMs); // lint-ignore: RAWTIMER LLM phase pipeline deadline

		const off = sense.subscribe("context.assemble", (event) => {
			if (event.correlationId !== correlationId) return;
			collected.push(parsePhaseResult(event.payload));
			if (quiescenceTimer !== undefined) clearTimeout(quiescenceTimer);
			quiescenceTimer = setTimeout(finish, PHASE_PIPELINE_QUIESCENCE_MS); // lint-ignore: RAWTIMER quiescence window
		});
	});
}

export async function runPhase(
	motor: MotorBus,
	sense: SenseBus,
	correlationId: string,
	messages: Message[],
	tools: Tool[],
	turn: number,
	phaseTimeoutMs: number,
): Promise<PhaseResult | undefined> {
	const t0 = Date.now();
	debugLog("llm:phase:enter", { turn });
	const phasePromise = waitForPhaseResult(sense, correlationId, phaseTimeoutMs);
	motor.publish({
		type: "context.assemble",
		payload: { messages: messages as unknown[], turn, toolCount: tools.length },
		correlationId,
	});
	const phase = await phasePromise;
	debugLog("llm:phase:exit", { turn, elapsedMs: Date.now() - t0, modified: !!phase });
	return phase;
}

export function applyPhaseResult(
	phase: PhaseResult,
	messages: Message[],
	tools: Tool[],
	nameMap: Map<string, string>,
	buildTools: (defs: readonly ToolDefinition[], nameMap: Map<string, string>) => Tool[],
): void {
	if (phase.kind === "continue") {
		if (phase.messages && phase.messages.length > 0) messages.splice(0, messages.length, ...phase.messages);
		if (phase.tools && phase.tools.length > 0) tools.splice(0, tools.length, ...buildTools(phase.tools, nameMap));
	}
}
