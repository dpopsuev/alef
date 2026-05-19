import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxProviderRegistration,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@dpopsuev/alef-ai";
import { describe, expect, it } from "vitest";
import type { Event } from "../src/board/event-log.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { DomainEventSpine } from "../src/core/domain-event-spine.js";
import type { ExtensionAPI } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import {
	DEFAULT_TERMINALBENCH_THRESHOLDS,
	evaluateTerminalBenchAcceptance,
	type TerminalBenchRun,
	type TerminalBenchTrack,
} from "../src/core/terminalbench.js";

const HEADLESS_PROMPT =
	'Build a minimal Node.js HTTP server in server.js with a GET /health endpoint returning JSON {"status":"ok"}. Validate syntax.';

const SCENARIO = "headless-http-server";
const REQUIRED_TOOL_ACTIONS = ["file_write", "file_bash", "file_read"] as const;
const REQUIRED_EVENT_KINDS = [
	"control.events.v1",
	"user.input",
	"assistant.output",
	"tool.called",
	"tool.result",
	"organ.invoke.v1",
	"organ.result.v1",
	"signal.events.v1",
] as const;

type RequiredEventKind = (typeof REQUIRED_EVENT_KINDS)[number];

const SERVER_SOURCE = `import http from "node:http";

const port = Number(process.env.PORT ?? "8080");

const server = http.createServer((req, res) => {
	if (req.method === "GET" && req.url === "/health") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ status: "ok" }));
		return;
	}

	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ status: "not_found" }));
});

server.listen(port);
`;

interface DeterministicCheckerResult {
	passed: boolean;
	failures: string[];
}

interface BenchmarkExecutionResult {
	run: TerminalBenchRun;
	checker: DeterministicCheckerResult;
}

describe("headless deterministic Alef checker benchmark", () => {
	it("passes baseline and ablation tracks with the full headless runtime", async () => {
		const baseline = await runHeadlessBenchmark("single-agent-baseline", "default");
		const ablation = await runHeadlessBenchmark("ablation-matrix", "minimal");

		expect(baseline.checker.passed, baseline.checker.failures.join("\n")).toBe(true);
		expect(ablation.checker.passed, ablation.checker.failures.join("\n")).toBe(true);
		expect(ablation.run.totalTokens).toBeLessThan(baseline.run.totalTokens);

		const verdict = evaluateTerminalBenchAcceptance([baseline.run, ablation.run], DEFAULT_TERMINALBENCH_THRESHOLDS);

		expect(verdict.passed, verdict.failures.join("\n")).toBe(true);
	}, 60000);
});

async function runHeadlessBenchmark(
	track: TerminalBenchTrack,
	strategy: "default" | "minimal",
): Promise<BenchmarkExecutionResult> {
	const root = join(tmpdir(), `alef-headless-bench-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const workspaceDir = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const faux = registerFauxProvider({
		models: [{ id: "faux-headless", name: "Faux Headless", reasoning: false }],
		tokenSize: { min: 512, max: 512 },
	});
	const model = faux.getModel("faux-headless");
	if (!model) {
		throw new Error("Failed to initialize faux benchmark model.");
	}
	faux.setResponses(buildDeterministicResponses(strategy));

	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");

	let eventSpine: DomainEventSpine | undefined;
	let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;

	try {
		const extensionFactory = createFauxExtensionFactory(faux);

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [extensionFactory],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});

			const result = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model,
			});
			eventSpine = result.eventSpine;

			return {
				...result,
				services,
				diagnostics: services.diagnostics,
			};
		};

		runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: workspaceDir,
			agentDir,
			sessionManager: SessionManager.inMemory(workspaceDir),
		});
		await runtime.session.bindExtensions({});
		await runtime.session.prompt(HEADLESS_PROMPT);

		if (!eventSpine) {
			throw new Error("Event spine was not initialized for benchmark run.");
		}

		const events = eventSpine.since(0);
		const checker = runDeterministicChecker(workspaceDir, events);
		const run: TerminalBenchRun = {
			track,
			scenario: SCENARIO,
			strategy,
			success: checker.passed,
			totalTokens: estimateAssistantOutputTokens(events),
			supervisorInvocations: countSupervisorInvocations(events),
			childSpawns: countChildSpawns(events),
			eventCoverageRatio: computeEventCoverageRatio(events),
		};

		return { run, checker };
	} finally {
		if (runtime) {
			await runtime.dispose();
		}
		faux.unregister();
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
}

function createFauxExtensionFactory(faux: FauxProviderRegistration): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		pi.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
	};
}

function buildDeterministicResponses(strategy: "default" | "minimal"): FauxResponseStep[] {
	const finalSummary =
		strategy === "default"
			? `Deterministic benchmark summary: ${"expanded-notes ".repeat(1200)}`
			: "Deterministic benchmark summary: minimal output.";

	return [
		fauxAssistantMessage(
			fauxToolCall("file_write", { path: "server.js", content: SERVER_SOURCE }, { id: "tool-write" }),
			{
				stopReason: "toolUse",
			},
		),
		fauxAssistantMessage(fauxToolCall("file_bash", { command: "node --check server.js" }, { id: "tool-bash" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(fauxToolCall("file_read", { path: "server.js" }, { id: "tool-read" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(finalSummary),
	];
}

function runDeterministicChecker(workspaceDir: string, events: Event[]): DeterministicCheckerResult {
	const failures: string[] = [];
	const serverPath = join(workspaceDir, "server.js");

	if (!existsSync(serverPath)) {
		failures.push("Checker: expected server.js to be created.");
	} else {
		const source = readFileSync(serverPath, "utf-8");
		for (const snippet of [
			'import http from "node:http"',
			"process.env.PORT",
			'"/health"',
			'status: "ok"',
			"server.listen",
		]) {
			if (!source.includes(snippet)) {
				failures.push(`Checker: server.js is missing required snippet: ${snippet}`);
			}
		}
	}

	const bashOk = events.some(
		(event) =>
			event.kind === "tool.result" &&
			getStringField(event.data, "toolName") === "file_bash" &&
			getBooleanField(event.data, "isError") === false,
	);
	if (!bashOk) {
		failures.push("Checker: expected a successful file_bash tool.result event.");
	}

	for (const action of REQUIRED_TOOL_ACTIONS) {
		const invoked = events.some(
			(event) => event.kind === "organ.invoke.v1" && getStringField(event.data, "action") === action,
		);
		if (!invoked) {
			failures.push(`Checker: missing organ.invoke.v1 for ${action}.`);
		}

		const succeeded = events.some(
			(event) =>
				event.kind === "organ.result.v1" &&
				getStringField(event.data, "action") === action &&
				getStringField(event.data, "status") === "ok",
		);
		if (!succeeded) {
			failures.push(`Checker: missing successful organ.result.v1 for ${action}.`);
		}
	}

	return {
		passed: failures.length === 0,
		failures,
	};
}

function computeEventCoverageRatio(events: Event[]): number {
	const seen = new Set<RequiredEventKind>();
	for (const event of events) {
		if (isRequiredEventKind(event.kind)) {
			seen.add(event.kind);
		}
	}
	return seen.size / REQUIRED_EVENT_KINDS.length;
}

function estimateAssistantOutputTokens(events: Event[]): number {
	let total = 0;
	for (const event of events) {
		if (event.kind !== "assistant.output") {
			continue;
		}
		const text = getStringField(event.data, "text");
		if (text) {
			total += estimateTextTokens(text);
		}
	}
	return total;
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function countSupervisorInvocations(events: Event[]): number {
	return events.filter(
		(event) => event.kind === "organ.invoke.v1" && getStringField(event.data, "organ") === "supervisor",
	).length;
}

function countChildSpawns(events: Event[]): number {
	return events.filter(
		(event) => event.kind === "control.events.v1" && getStringField(event.data, "event") === "child.spawned",
	).length;
}

function isRequiredEventKind(kind: string): kind is RequiredEventKind {
	return REQUIRED_EVENT_KINDS.includes(kind as RequiredEventKind);
}

function getStringField(value: unknown, field: string): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const candidate = value[field];
	return typeof candidate === "string" ? candidate : undefined;
}

function getBooleanField(value: unknown, field: string): boolean | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const candidate = value[field];
	return typeof candidate === "boolean" ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
