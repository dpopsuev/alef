/**
 * BlueprintHarness — deterministic blueprint test harness.
 *
 * Loads a blueprint (file or inline adapters), wires ScriptedReasoner,
 * provides send() + assertion API. No real LLM call. No API key needed.
 *
 * Two factory methods:
 * BlueprintHarness.fromBlueprint(path, opts) — loads agent.yaml
 * BlueprintHarness.create(opts) — inline adapter list
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

import type { CompiledAgentDefinition } from "@dpopsuev/alef-blueprint/types";
import { loadAgentDefinition } from "@dpopsuev/alef-blueprint/blueprints";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { BusMessage, CommandMessage } from "@dpopsuev/alef-kernel/bus";
import type { ExecutionStrategy, SendRequest } from "@dpopsuev/alef-kernel/execution";
import { Agent } from "@dpopsuev/alef-engine/agent";
import { AgentController } from "@dpopsuev/alef-engine/controller";
import { BusEventRecorder } from "./bus-event-recorder.js";
import type { ScriptStep } from "./script.js";
import { ScriptedReasoner } from "./scripted-reasoner.js";

// ---------------------------------------------------------------------------
// BlueprintHarness
// ---------------------------------------------------------------------------

/** Configuration for creating a BlueprintHarness. */
export interface BlueprintHarnessOptions {
	/** Working directory for adapters. Required. */
	cwd: string;
	/** Script steps for ScriptedReasoner. */
	script: ScriptStep[];
	/** Optional system prompt override. */
	systemPrompt?: string;
	/** Timeout per send() call in ms. Default: 30_000. */
	timeoutMs?: number;
}

/** Function that converts a compiled agent definition into adapter instances. */
export type MaterializeFn = (
	definition: CompiledAgentDefinition,
	opts: { cwd: string },
) => Promise<{ adapters: Adapter[] }>;

/** Options for loading a BlueprintHarness from a YAML file. */
export interface BlueprintFromFileOptions extends BlueprintHarnessOptions {
	/** Extra adapters to load beyond what the blueprint declares. */
	extraAdapters?: Adapter[];
	/**
	 * Blueprint materializer — converts a CompiledAgentDefinition into Adapter instances.
	 * Pass materializeBlueprint from @dpopsuev/alef or alef-coding-agent.
	 * Decouples testkit from the runner package.
	 */
	materialize: MaterializeFn;
}

/** Deterministic blueprint test harness with scripted LLM and assertions. */
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
	 * Load a blueprint from a YAML file, instantiate its adapters, inject
	 * ScriptedReasoner. Real adapters execute (FsAdapter, ShellAdapter, etc.).
	 */
	static async fromBlueprint(blueprintPath: string, opts: BlueprintFromFileOptions): Promise<BlueprintHarness> {
		const definition = loadAgentDefinition(blueprintPath);
		const materialized = await opts.materialize(definition, { cwd: opts.cwd });

		const adapters = [...materialized.adapters, ...(opts.extraAdapters ?? [])];
		return BlueprintHarness.create({ ...opts, adapters });
	}

	// -------------------------------------------------------------------------
	// Factory — inline adapters (no blueprint file required)
	// -------------------------------------------------------------------------

	/**
	 * Create a harness with an explicit adapter list. Useful when testing
	 * custom adapters directly or when no blueprint file is available.
	 */
	static create(opts: BlueprintHarnessOptions & { adapters?: Adapter[] }): BlueprintHarness {
		const recorder = new BusEventRecorder();
		const scriptedLlm = new ScriptedReasoner(opts.script);
		const agent = new Agent();

		agent.load(scriptedLlm);
		for (const adapter of opts.adapters ?? []) {
			agent.load(adapter);
		}

		agent.observe(recorder);
		agent.validate();

		const controller = new AgentController(agent);
		// eslint-disable-next-line no-magic-numbers
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
	 * Inject an arbitrary event to trigger the Reasoner (autonomous agents).
	 * Waits for the configured replyEvent to arrive on the command bus.
	 * @param eventType - the event type (e.g. 'git.push', 'cron.tick')
	 * @param payload - the event payload
	 * @param replyEvent - command event type to wait for (default: same as eventType)
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
			const unsub = this.agent.subscribeCommand(waitFor, (event) => {
				clearTimeout(timer);
				unsub();
				resolve(event.payload);
			});
		});
		this.agent.publishEvent({
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

	/** All Command events from the last send() call. */
	get commandEvents(): readonly BusMessage[] {
		return this.recorder.command;
	}

	/** All Event messages from the last send() call. */
	get eventMessages(): readonly BusMessage[] {
		return this.recorder.event;
	}

	// -------------------------------------------------------------------------
	// Assertions
	// -------------------------------------------------------------------------

	/**
	 * Assert that a Command event with the given event type was published.
	 * @param toolName EDA event type, e.g. "fs.read"
	 */
	assertToolCalled(toolName: string): BusMessage {
		const found = this.recorder.command.find((e) => e.type === toolName);
		if (!found) {
			const called = [...new Set(this.recorder.command.map((e) => e.type))].join(", ");
			throw new Error(`Expected Command/${toolName} to be published.\n` + `Command events: [${called || "none"}]`);
		}
		return found;
	}

	/**
	 * Assert that a Command event was published AND its payload contains the
	 * given partial args (deep subset check).
	 */
	assertToolCalledWith(toolName: string, partialArgs: Record<string, unknown>): void {
		const event = this.assertToolCalled(toolName);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing BusMessage to CommandMessage for payload access
		const payload = (event as CommandMessage).payload;
		for (const [key, expected] of Object.entries(partialArgs)) {
			if (payload[key] !== expected) {
				throw new Error(
					`Command/${toolName} payload.${key}: expected ${JSON.stringify(expected)}, ` +
						`got ${JSON.stringify(payload[key])}`,
				);
			}
		}
	}

	/**
	 * Assert that a Command event with the given type was NOT published.
	 */
	assertNotToolCalled(toolName: string): void {
		const found = this.recorder.command.find((e) => e.type === toolName);
		if (found) {
			throw new Error(
				`Expected Command/${toolName} NOT to be published, but it was.\n` +
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing BusMessage to CommandMessage for payload access
					`Payload: ${JSON.stringify((found as CommandMessage).payload)}`,
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
	async dispose(): Promise<void> {
		await this.agent.dispose();
	}
}
