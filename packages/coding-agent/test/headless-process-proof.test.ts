import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	DEFAULT_TERMINALBENCH_THRESHOLDS,
	evaluateTerminalBenchAcceptance,
	type TerminalBenchRun,
	type TerminalBenchTrack,
} from "../src/core/terminalbench.js";
import type { RpcCommand } from "../src/modes/rpc/rpc-types.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = resolve(__dirname, "../../../tsconfig.json");

const HEADLESS_PROMPT =
	'Build a minimal Node.js HTTP server in server.js with a GET /health endpoint returning JSON {"status":"ok"}. Validate syntax.';

const SCENARIO = "headless-http-server-rpc";
const REQUIRED_TOOL_ACTIONS = ["file_write", "file_bash", "file_read"] as const;
const REQUIRED_EVENT_TYPES = [
	"agent_start",
	"message_end",
	"tool_execution_start",
	"tool_execution_end",
	"agent_end",
] as const;

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

type JsonRecord = Record<string, unknown>;
type RequiredEventType = (typeof REQUIRED_EVENT_TYPES)[number];
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

interface DeterministicCheckerResult {
	passed: boolean;
	failures: string[];
}

interface ProcessBenchmarkResult {
	run: TerminalBenchRun;
	checker: DeterministicCheckerResult;
}

interface ProcessProofRunOptions {
	track: TerminalBenchTrack;
	strategy: "default" | "minimal";
	coldStart?: boolean;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("headless process proof ladder", () => {
	it("proves spawned RPC process baseline+ablation benchmark acceptance", async () => {
		const baseline = await runProcessBenchmark({ track: "single-agent-baseline", strategy: "default" });
		const ablation = await runProcessBenchmark({ track: "ablation-matrix", strategy: "minimal" });

		expect(baseline.checker.passed, baseline.checker.failures.join("\n")).toBe(true);
		expect(ablation.checker.passed, ablation.checker.failures.join("\n")).toBe(true);
		expect(ablation.run.totalTokens).toBeLessThan(baseline.run.totalTokens);

		const verdict = evaluateTerminalBenchAcceptance([baseline.run, ablation.run], DEFAULT_TERMINALBENCH_THRESHOLDS);
		expect(verdict.passed, verdict.failures.join("\n")).toBe(true);
	}, 90000);

	it("proves cold-start boot from empty agent dir and empty workspace", async () => {
		const coldStart = await runProcessBenchmark({
			track: "single-agent-baseline",
			strategy: "minimal",
			coldStart: true,
		});

		expect(coldStart.checker.passed, coldStart.checker.failures.join("\n")).toBe(true);
		expect(coldStart.run.success).toBe(true);
	}, 90000);
});

async function runProcessBenchmark(options: ProcessProofRunOptions): Promise<ProcessBenchmarkResult> {
	const root = mkdtempSync(join(tmpdir(), "alef-rpc-proof-"));
	tempDirs.push(root);

	const workspaceDir = join(root, "workspace");
	const agentDir = join(root, "agent");
	const extensionPath = join(root, "faux-proof-extension.mjs");

	mkdirSync(workspaceDir, { recursive: true });
	if (!options.coldStart) {
		mkdirSync(agentDir, { recursive: true });
	}
	writeFileSync(extensionPath, buildExtensionSource(options.strategy), "utf-8");

	const harness = new RpcProcessHarness({
		cwd: workspaceDir,
		agentDir,
		extensionPath,
	});

	try {
		await harness.start();
		const state = await harness.requestData<{ model?: { provider?: string; id?: string } }>({ type: "get_state" });
		if (state.model?.provider !== "faux" || state.model?.id !== "faux-headless") {
			throw new Error(`RPC process started with unexpected model: ${JSON.stringify(state.model)}`);
		}

		const events = await harness.promptAndCollect(HEADLESS_PROMPT);
		const messages = await harness.requestData<{ messages: Array<{ role?: string; content?: unknown }> }>({
			type: "get_messages",
		});

		const checker = runDeterministicChecker(workspaceDir, events, messages.messages);
		const run: TerminalBenchRun = {
			track: options.track,
			scenario: SCENARIO,
			strategy: options.strategy,
			success: checker.passed,
			totalTokens: estimateAssistantTokensFromEvents(events),
			supervisorInvocations: countSupervisorInvocations(events),
			childSpawns: 0,
			eventCoverageRatio: computeEventCoverageRatio(events),
		};

		if (options.coldStart) {
			const sessionsPath = join(agentDir, "sessions");
			if (!existsSync(sessionsPath)) {
				throw new Error("Cold-start proof failed: expected session storage to be created.");
			}
		}

		return { run, checker };
	} finally {
		await harness.stop();
	}
}

function buildExtensionSource(strategy: "default" | "minimal"): string {
	const finalSummary =
		strategy === "default"
			? `Deterministic benchmark summary: ${"expanded-notes ".repeat(1200)}`
			: "Deterministic benchmark summary: minimal output.";

	return `import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@dpopsuev/alef-ai";

const SERVER_SOURCE = ${JSON.stringify(SERVER_SOURCE)};
const FINAL_SUMMARY = ${JSON.stringify(finalSummary)};

export default function (pi) {
	const faux = registerFauxProvider({
		provider: "faux",
		api: "faux-rpc-proof-${strategy}",
		models: [{ id: "faux-headless", name: "Faux Headless", reasoning: false }],
		tokenSize: { min: 512, max: 512 },
	});

	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("file_write", { path: "server.js", content: SERVER_SOURCE }, { id: "tool-write" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("file_bash", { command: "node --check server.js" }, { id: "tool-bash" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("file_read", { path: "server.js" }, { id: "tool-read" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(FINAL_SUMMARY),
	]);

	pi.registerProvider("faux", {
		baseUrl: faux.getModel().baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	});
}
`;
}

function runDeterministicChecker(
	workspaceDir: string,
	events: JsonRecord[],
	messages: Array<{ role?: string; content?: unknown }>,
): DeterministicCheckerResult {
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

	for (const action of REQUIRED_TOOL_ACTIONS) {
		const sawStart = events.some(
			(event) =>
				getStringField(event, "type") === "tool_execution_start" && getStringField(event, "toolName") === action,
		);
		if (!sawStart) {
			failures.push(`Checker: missing tool_execution_start for ${action}.`);
		}

		const sawSuccess = events.some(
			(event) =>
				getStringField(event, "type") === "tool_execution_end" &&
				getStringField(event, "toolName") === action &&
				getBooleanField(event, "isError") === false,
		);
		if (!sawSuccess) {
			failures.push(`Checker: missing successful tool_execution_end for ${action}.`);
		}
	}

	if (!messages.some((message) => message.role === "toolResult")) {
		failures.push("Checker: expected persisted toolResult messages.");
	}

	return {
		passed: failures.length === 0,
		failures,
	};
}

function estimateAssistantTokensFromEvents(events: JsonRecord[]): number {
	let total = 0;
	for (const event of events) {
		if (getStringField(event, "type") !== "message_end") {
			continue;
		}

		const message = getRecordField(event, "message");
		if (!message || getStringField(message, "role") !== "assistant") {
			continue;
		}

		total += estimateTextTokens(extractAssistantText(message));
	}
	return total;
}

function extractAssistantText(message: JsonRecord): string {
	const content = message.content;
	if (!Array.isArray(content)) {
		return "";
	}

	const lines: string[] = [];
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
			lines.push(part.text);
		}
	}
	return lines.join("\n");
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function countSupervisorInvocations(events: JsonRecord[]): number {
	return events.filter(
		(event) =>
			getStringField(event, "type") === "tool_execution_start" && getStringField(event, "toolName") === "supervisor",
	).length;
}

function computeEventCoverageRatio(events: JsonRecord[]): number {
	const seen = new Set<RequiredEventType>();
	for (const event of events) {
		const type = getStringField(event, "type");
		if (isRequiredEventType(type)) {
			seen.add(type);
		}
	}
	return seen.size / REQUIRED_EVENT_TYPES.length;
}

function isRequiredEventType(value: string | undefined): value is RequiredEventType {
	return value !== undefined && REQUIRED_EVENT_TYPES.includes(value as RequiredEventType);
}

function getStringField(value: unknown, field: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = value[field];
	return typeof candidate === "string" ? candidate : undefined;
}

function getBooleanField(value: unknown, field: string): boolean | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = value[field];
	return typeof candidate === "boolean" ? candidate : undefined;
}

function getRecordField(value: unknown, field: string): JsonRecord | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = value[field];
	return isRecord(candidate) ? candidate : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null;
}

class RpcProcessHarness {
	private process: ChildProcess | undefined;
	private stdoutBuffer = "";
	private requestCounter = 0;
	private events: JsonRecord[] = [];
	private waiters: Array<{
		startIndex: number;
		predicate: (event: JsonRecord) => boolean;
		resolve: (event: JsonRecord) => void;
		reject: (error: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	}> = [];
	private pendingRequests = new Map<
		string,
		{
			resolve: (response: JsonRecord) => void;
			reject: (error: Error) => void;
			timeout: ReturnType<typeof setTimeout>;
		}
	>();
	private stderr = "";

	constructor(
		private readonly options: {
			cwd: string;
			agentDir: string;
			extensionPath: string;
		},
	) {}

	async start(): Promise<void> {
		if (this.process) {
			throw new Error("RPC harness is already running.");
		}

		this.process = spawn(
			process.execPath,
			[
				tsxPath,
				cliPath,
				"--mode",
				"rpc",
				"--provider",
				"faux",
				"--model",
				"faux-headless",
				"--extension",
				this.options.extensionPath,
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
			],
			{
				cwd: this.options.cwd,
				env: {
					...process.env,
					[ENV_AGENT_DIR]: this.options.agentDir,
					ALEF_OFFLINE: "1",
					ALEF_SKIP_VERSION_CHECK: "1",
					TSX_TSCONFIG_PATH: tsconfigPath,
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		this.process.stdout?.on("data", (chunk: Buffer | string) => {
			this.handleStdoutChunk(chunk.toString());
		});

		this.process.stderr?.on("data", (chunk: Buffer | string) => {
			this.stderr += chunk.toString();
		});

		this.process.on("exit", (code) => {
			this.rejectAll(new Error(`RPC process exited with code ${code}. stderr: ${this.stderr}`));
		});

		await this.requestData({ type: "get_state" });
	}

	async stop(): Promise<void> {
		const processRef = this.process;
		if (!processRef) {
			return;
		}

		this.process = undefined;
		processRef.stdin?.end();

		await new Promise<void>((resolvePromise) => {
			const timeout = setTimeout(() => {
				processRef.kill("SIGKILL");
				resolvePromise();
			}, 2000);
			processRef.once("close", () => {
				clearTimeout(timeout);
				resolvePromise();
			});
		});

		this.rejectAll(new Error("RPC harness stopped."));
	}

	async requestData<T>(command: RpcCommandBody): Promise<T> {
		const response = await this.send(command);
		if (getBooleanField(response, "success") !== true) {
			const message =
				getStringField(response, "error") ?? `RPC command failed: ${getStringField(response, "command")}`;
			throw new Error(message);
		}
		return response.data as T;
	}

	async promptAndCollect(message: string): Promise<JsonRecord[]> {
		const startIndex = this.events.length;
		await this.requestData<void>({ type: "prompt", message });
		await this.waitForEvent((event) => getStringField(event, "type") === "agent_end", startIndex, 30000);
		return this.events.slice(startIndex);
	}

	private async send(command: RpcCommandBody): Promise<JsonRecord> {
		const processRef = this.process;
		if (!processRef?.stdin) {
			throw new Error("RPC harness is not running.");
		}

		const id = `req-${++this.requestCounter}`;
		const payload = { ...command, id };

		return await new Promise<JsonRecord>((resolvePromise, rejectPromise) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				rejectPromise(new Error(`Timed out waiting for response to ${command.type}. stderr: ${this.stderr}`));
			}, 30000);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolvePromise(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					rejectPromise(error);
				},
				timeout,
			});

			processRef.stdin!.write(`${JSON.stringify(payload)}\n`);
		});
	}

	private waitForEvent(
		predicate: (event: JsonRecord) => boolean,
		startIndex: number,
		timeoutMs: number,
	): Promise<JsonRecord> {
		for (let i = startIndex; i < this.events.length; i++) {
			const event = this.events[i];
			if (predicate(event)) {
				return Promise.resolve(event);
			}
		}

		return new Promise<JsonRecord>((resolvePromise, rejectPromise) => {
			const timeout = setTimeout(() => {
				this.waiters = this.waiters.filter((waiter) => waiter.timeout !== timeout);
				rejectPromise(new Error(`Timed out waiting for event. stderr: ${this.stderr}`));
			}, timeoutMs);

			this.waiters.push({
				startIndex,
				predicate,
				resolve: resolvePromise,
				reject: rejectPromise,
				timeout,
			});
		});
	}

	private handleStdoutChunk(chunk: string): void {
		this.stdoutBuffer += chunk;
		while (true) {
			const lineBreak = this.stdoutBuffer.indexOf("\n");
			if (lineBreak < 0) break;

			const rawLine = this.stdoutBuffer.slice(0, lineBreak);
			this.stdoutBuffer = this.stdoutBuffer.slice(lineBreak + 1);
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			if (!line) continue;

			let parsed: JsonRecord | undefined;
			try {
				const candidate = JSON.parse(line);
				if (isRecord(candidate)) {
					parsed = candidate;
				}
			} catch {
				parsed = undefined;
			}
			if (!parsed) continue;

			if (getStringField(parsed, "type") === "response") {
				const responseId = getStringField(parsed, "id");
				if (responseId && this.pendingRequests.has(responseId)) {
					const pending = this.pendingRequests.get(responseId)!;
					this.pendingRequests.delete(responseId);
					clearTimeout(pending.timeout);
					pending.resolve(parsed);
					continue;
				}
			}

			this.events.push(parsed);
			const eventIndex = this.events.length - 1;
			const remaining: typeof this.waiters = [];
			for (const waiter of this.waiters) {
				if (eventIndex >= waiter.startIndex && waiter.predicate(parsed)) {
					clearTimeout(waiter.timeout);
					waiter.resolve(parsed);
				} else {
					remaining.push(waiter);
				}
			}
			this.waiters = remaining;
		}
	}

	private rejectAll(error: Error): void {
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pendingRequests.clear();

		for (const waiter of this.waiters) {
			clearTimeout(waiter.timeout);
			waiter.reject(error);
		}
		this.waiters = [];
	}
}
