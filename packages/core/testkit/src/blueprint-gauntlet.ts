/**
 * BlueprintGauntlet \u2014 story-based blueprint test harness.
 *
 * A typed harness for structured e2e blueprint testing organized as Stories.
 * Each Story creates a fresh gauntlet with its own TempDir, stub adapters, and
 * scripted LLM. Stories are independent and self-contained.
 *
 * Mirrors Tako testkit/acceptance/SDLCGauntlet pattern:
 * - NewGauntlet(t) creates a fully wired test environment
 * - Run() / Resume() walk the agent turn loop
 * - assertToolCalled() / assertToolCalledWith() verify adapter behavior
 * - withStubAdapter() replaces a real adapter with a stub for isolation
 *
 * Gate/approval workflows are stubbed for now \u2014 the adapter-agent integration
 * will wire real approval gates when (ContextAdapter) is complete.
 *
 */

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Adapter, gimpedAdapter } from "@dpopsuev/alef-kernel/adapter";
import type { ExecutionStrategy, SendRequest } from "@dpopsuev/alef-kernel/execution";
import { Agent, AgentController } from "@dpopsuev/alef-runtime";
import { BusEventRecorder } from "./bus-event-recorder.js";
import { type ScriptStep, step } from "./script.js";
import { ScriptedReasoner } from "./scripted-reasoner.js";

export interface GauntletOptions {
	/** Adapters to mount. Required. */
	adapters: Adapter[];
	/** Script steps for the ScriptedReasoner. */
	script?: ScriptStep[];
	/** System prompt for the agent. Default: "You are a helpful assistant." */
	systemPrompt?: string;
	/** Timeout per send() call in ms. Default: 30_000. */
	timeoutMs?: number;
}

export interface GauntletSendOptions {
	/** Additional script steps to append before this send. */
	prependSteps?: ScriptStep[];
}

/**
 * BlueprintGauntlet \u2014 story-based blueprint test harness.
 *
 * @example
 * const g = await BlueprintGauntlet.create({
 * adapters: [createFsAdapter({ cwd: workspace })],
 * script: [
 * step.text("Here is the file."),
 * ],
 * });
 * const reply = await g.send("Read README.md");
 * g.assertToolCalled("fs.read");
 * await g.dispose();
 */
export class BlueprintGauntlet implements ExecutionStrategy {
	readonly workspace: string;
	private readonly agent: Agent;
	private readonly controller: AgentController;
	private readonly recorder: BusEventRecorder;
	readonly scriptedLlm: ScriptedReasoner;
	private readonly timeoutMs: number;

	private constructor(
		workspace: string,
		agent: Agent,
		controller: AgentController,
		recorder: BusEventRecorder,
		scriptedLlm: ScriptedReasoner,
		timeoutMs: number,
	) {
		this.workspace = workspace;
		this.agent = agent;
		this.controller = controller;
		this.recorder = recorder;
		this.scriptedLlm = scriptedLlm;
		this.timeoutMs = timeoutMs;
	}

	// ---------------------------------------------------------------------------
	// Factory
	// ---------------------------------------------------------------------------

	static async create(opts: GauntletOptions): Promise<BlueprintGauntlet> {
		const workspace = join(tmpdir(), `alef-gauntlet-${Date.now()}`);
		await mkdir(workspace, { recursive: true });

		const script = opts.script ?? [step.reply("Done.")];
		const scriptedLlm = new ScriptedReasoner(script);
		const recorder = new BusEventRecorder();

		const agent = new Agent();
		for (const adapter of [...opts.adapters, scriptedLlm]) {
			agent.load(adapter);
		}
		agent.observe(recorder);

		const controller = new AgentController(agent);
		return new BlueprintGauntlet(workspace, agent, controller, recorder, scriptedLlm, opts.timeoutMs ?? 30_000);
	}

	// ---------------------------------------------------------------------------
	// Interaction
	// ---------------------------------------------------------------------------

	/** Send a message to the agent and await the reply. */
	async send({ text }: SendRequest): Promise<string> {
		return this.controller.send(text, "human", this.timeoutMs);
	}

	// ---------------------------------------------------------------------------
	// Story isolation \u2014 replace a real adapter with a gimped stub
	// ---------------------------------------------------------------------------

	/**
	 * Returns a new GauntletOptions with the named adapter replaced by a GimpedAdapter.
	 * Use to establish ablation baselines within a story:
	 *
	 * @example
	 * const opts = { adapters: [fsAdapter, shellAdapter], script: [...] };
	 * const full = await BlueprintGauntlet.create(opts);
	 * const baseline = await BlueprintGauntlet.create(
	 * BlueprintGauntlet.withGimpedAdapter(opts, "fs")
	 * );
	 * // Compare full vs baseline to measure fsAdapter's contribution.
	 */
	static withGimpedAdapter(opts: GauntletOptions, adapterName: string): GauntletOptions {
		return {
			...opts,
			adapters: opts.adapters.map((o) => (o.name === adapterName ? gimpedAdapter(adapterName) : o)),
		};
	}

	// ---------------------------------------------------------------------------
	// Assertions
	// ---------------------------------------------------------------------------

	/** Assert a tool was called at least once during the run. */
	assertToolCalled(toolName: string): void {
		const motorEvents = this.recorder.command;
		const found = motorEvents.some((e) => e.type === toolName);
		if (!found) {
			const calls = [...new Set(motorEvents.map((e) => e.type))].join(", ") || "none";
			throw new Error(`Expected tool "${toolName}" to be called.\nCommand events: [${calls}]`);
		}
	}

	/** Assert a tool was NOT called during the run. */
	assertToolNotCalled(toolName: string): void {
		const found = this.recorder.command.some((e) => e.type === toolName);
		if (found) {
			throw new Error(`Expected tool "${toolName}" NOT to be called, but it was.`);
		}
	}

	/** Assert a tool was called with a specific payload (partial match). */
	assertToolCalledWith(toolName: string, expectedPayload: Record<string, unknown>): void {
		const calls = this.recorder.command.filter((e) => e.type === toolName);
		if (calls.length === 0) {
			throw new Error(`Expected tool "${toolName}" to be called, but it was not.`);
		}
		const matched = calls.some((e) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- BusMessage lacks payload; narrowing via cast
			const p = (e as unknown as { payload?: Record<string, unknown> }).payload ?? {};
			return Object.entries(expectedPayload).every(([k, v]) => JSON.stringify(p[k]) === JSON.stringify(v));
		});
		if (!matched) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- BusMessage lacks payload; narrowing via cast
			const payloads = calls.map((e) => JSON.stringify((e as unknown as { payload?: unknown }).payload)).join("\n ");
			throw new Error(
				`Tool "${toolName}" was called but not with expected payload ${JSON.stringify(expectedPayload)}.\n Actual payloads:\n ${payloads}`,
			);
		}
	}

	/** Assert no tools were called (reply-only turn). */
	assertNoToolsCalled(): void {
		const toolEvents = this.recorder.command.filter((e) => e.type !== "llm.response");
		if (toolEvents.length > 0) {
			const names = [...new Set(toolEvents.map((e) => e.type))].join(", ");
			throw new Error(`Expected no tool calls, but got: [${names}]`);
		}
	}

	/** Returns all Command event types observed during the run. */
	get calledTools(): string[] {
		return [...new Set(this.recorder.command.map((e) => e.type))];
	}

	/** Returns all recorded command events. */
	get commandEvents() {
		return this.recorder.command;
	}

	/** Returns all recorded event messages. */
	get eventMessages() {
		return this.recorder.event;
	}

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------

	/** Clear recorded events between turns within a story. */
	clearRecorder(): void {
		this.recorder.clear();
	}

	/** Unmount the agent and clean up the temp workspace. */
	async dispose(): Promise<void> {
		this.agent.dispose();
		await rm(this.workspace, { recursive: true, force: true });
	}
}
