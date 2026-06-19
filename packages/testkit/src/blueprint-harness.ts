/**
 * BlueprintHarness — deterministic blueprint test harness.
 *
 * Loads a blueprint (file or inline organs), wires ScriptedReasoner,
 * provides send() + assertion API. No real LLM call. No API key needed.
 *
 * Two factory methods:
 * BlueprintHarness.fromBlueprint(path, opts) — loads agent.yaml
 * BlueprintHarness.create(opts) — inline organ list
 *
 * Example:
 * const h = await BlueprintHarness.fromBlueprint("agent.yaml", {
 * cwd: workspace,
 * script: [
 * step.toolCall("fs.read", { path: "src/auth.ts" }, "Found the bug."),
 * ],
 * });
 * const reply = await h.send("What does login() do?");
 * h.assertToolCalled("fs.read");
 * h.assertToolCalledWith("fs.read", { path: "src/auth.ts" });
 * h.dispose();
 *
 */

import type { CompiledAgentDefinition } from "@dpopsuev/alef-agent-blueprint";
import { loadAgentDefinition } from "@dpopsuev/alef-agent-blueprint";
import type { ExecutionStrategy, MotorEvent, NerveEvent, Organ, SendRequest } from "@dpopsuev/alef-kernel";
import { Agent, AgentController, type BusObserver } from "@dpopsuev/alef-runtime";
import { BusEventRecorder } from "./index.js";
import type { ScriptStep } from "./script.js";
import { ScriptedReasoner } from "./scripted-reasoner.js";

// ---------------------------------------------------------------------------
// BlueprintHarness
// ---------------------------------------------------------------------------

export interface BlueprintHarnessOptions {
	/** Working directory for organs. Required. */
	cwd: string;
	/** Script steps for ScriptedReasoner. */
	script: ScriptStep[];
	/** Optional system prompt override. */
	systemPrompt?: string;
	/** Timeout per send() call in ms. Default: 30_000. */
	timeoutMs?: number;
}

export type MaterializeFn = (
	definition: CompiledAgentDefinition,
	opts: { cwd: string },
) => Promise<{ organs: Organ[] }>;

export interface BlueprintFromFileOptions extends BlueprintHarnessOptions {
	/** Extra organs to load beyond what the blueprint declares. */
	extraOrgans?: Organ[];
	/**
	 * Blueprint materializer — converts a CompiledAgentDefinition into Organ instances.
	 * Pass materializeBlueprint from @dpopsuev/alef-runner or alef-coding-agent.
	 * Decouples testkit from the runner package.
	 */
	materialize: MaterializeFn;
}

export class BlueprintHarness implements ExecutionStrategy {
	private readonly agent: Agent;
	private readonly controller: AgentController;
	private readonly recorder: BusEventRecorder;
	/** Exposed for advanced test scenarios (e.g. reset between turns). */
	readonly scriptedLlm: ScriptedReasoner;
	private readonly timeoutMs: number;
	private _lastReply = "";

	private constructor(
		agent: Agent,
		controller: AgentController,
		recorder: BusEventRecorder,
		scriptedLlm: ScriptedReasoner,
		timeoutMs: number,
	) {
		this.agent = agent;
		this.controller = controller;
		this.recorder = recorder;
		this.scriptedLlm = scriptedLlm;
		this.timeoutMs = timeoutMs;
	}

	// -------------------------------------------------------------------------
	// Factory — from a blueprint file
	// -------------------------------------------------------------------------

	/**
	 * Load a blueprint from a YAML file, instantiate its organs, inject
	 * ScriptedReasoner. Real organs execute (FsOrgan, ShellOrgan, etc.).
	 */
	static async fromBlueprint(blueprintPath: string, opts: BlueprintFromFileOptions): Promise<BlueprintHarness> {
		const definition = loadAgentDefinition(blueprintPath);
		const materialized = await opts.materialize(definition, { cwd: opts.cwd });

		const organs = [...materialized.organs, ...(opts.extraOrgans ?? [])];
		return BlueprintHarness.create({ ...opts, organs: organs });
	}

	// -------------------------------------------------------------------------
	// Factory — inline organs (no blueprint file required)
	// -------------------------------------------------------------------------

	/**
	 * Create a harness with an explicit organ list. Useful when testing
	 * custom organs directly or when no blueprint file is available.
	 */
	static create(opts: BlueprintHarnessOptions & { organs?: Organ[] }): BlueprintHarness {
		const recorder = new BusEventRecorder();
		const scriptedLlm = new ScriptedReasoner(opts.script);
		const agent = new Agent();

		agent.load(scriptedLlm);
		for (const organ of opts.organs ?? []) {
			agent.load(organ);
		}

		agent.observe(recorder as BusObserver);
		agent.validate();

		const controller = new AgentController(agent);
		return new BlueprintHarness(agent, controller, recorder, scriptedLlm, opts.timeoutMs ?? 30_000);
	}

	// -------------------------------------------------------------------------
	// API
	// -------------------------------------------------------------------------

	/** Send a message to the agent and return its reply (conversation agents). */
	async send({ text }: SendRequest): Promise<string> {
		this.recorder.clear();
		const reply = await this.controller.send(text, "human", this.timeoutMs);
		this._lastReply = reply;
		return reply;
	}

	/**
	 * Inject an arbitrary sense event to trigger the Reasoner (autonomous agents).
	 * Waits for the configured replyEvent to arrive on the motor bus.
	 * @param eventType - the sense event type (e.g. 'git.push', 'cron.tick')
	 * @param payload - the event payload
	 * @param replyEvent - motor event type to wait for (default: same as eventType)
	 */
	async trigger(
		eventType: string,
		payload: Record<string, unknown>,
		replyEvent?: string,
	): Promise<Record<string, unknown>> {
		this.recorder.clear();
		const waitFor = replyEvent ?? eventType;
		const replyP = new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`trigger: no ${waitFor} reply within ${this.timeoutMs}ms`)),
				this.timeoutMs,
			);
			const unsub = this.agent.subscribeMotor(waitFor, (event) => {
				clearTimeout(timer);
				unsub();
				resolve(event.payload as Record<string, unknown>);
			});
		});
		this.agent.publishSense({
			type: eventType,
			payload,
			correlationId: `trigger-${Date.now()}`,
			isError: false,
		});
		return replyP;
	}

	/** Last reply returned by send(). */
	get lastReply(): string {
		return this._lastReply;
	}

	/** All Motor events from the last send() call. */
	get motorEvents(): readonly NerveEvent[] {
		return this.recorder.motor;
	}

	/** All Sense events from the last send() call. */
	get senseEvents(): readonly NerveEvent[] {
		return this.recorder.sense;
	}

	// -------------------------------------------------------------------------
	// Assertions
	// -------------------------------------------------------------------------

	/**
	 * Assert that a Motor event with the given event type was published.
	 * @param toolName EDA event type, e.g. "fs.read"
	 */
	assertToolCalled(toolName: string): NerveEvent {
		const found = this.recorder.motor.find((e) => e.type === toolName);
		if (!found) {
			const called = [...new Set(this.recorder.motor.map((e) => e.type))].join(", ");
			throw new Error(`Expected Motor/${toolName} to be published.\n` + `Motor events: [${called || "none"}]`);
		}
		return found;
	}

	/**
	 * Assert that a Motor event was published AND its payload contains the
	 * given partial args (deep subset check).
	 */
	assertToolCalledWith(toolName: string, partialArgs: Record<string, unknown>): void {
		const event = this.assertToolCalled(toolName);
		const payload = (event as MotorEvent).payload;
		for (const [key, expected] of Object.entries(partialArgs)) {
			if (payload[key] !== expected) {
				throw new Error(
					`Motor/${toolName} payload.${key}: expected ${JSON.stringify(expected)}, ` +
						`got ${JSON.stringify(payload[key])}`,
				);
			}
		}
	}

	/**
	 * Assert that a Motor event with the given type was NOT published.
	 */
	assertNotToolCalled(toolName: string): void {
		const found = this.recorder.motor.find((e) => e.type === toolName);
		if (found) {
			throw new Error(
				`Expected Motor/${toolName} NOT to be published, but it was.\n` +
					`Payload: ${JSON.stringify((found as MotorEvent).payload)}`,
			);
		}
	}

	/**
	 * Assert that the last reply contains the given substring (case-insensitive).
	 */
	assertReply(substring: string): void {
		if (!this._lastReply.toLowerCase().includes(substring.toLowerCase())) {
			throw new Error(`Expected reply to contain '${substring}'.\n` + `Reply: '${this._lastReply}'`);
		}
	}

	/** Dispose the agent and clean up. */
	dispose(): void {
		this.agent.dispose();
	}
}
