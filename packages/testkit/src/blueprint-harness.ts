/**
 * BlueprintHarness — deterministic blueprint test harness.
 *
 * Loads a blueprint (file or inline organs), wires ScriptedLLMOrgan,
 * provides send() + assertion API. No real LLM call. No API key needed.
 *
 * Two factory methods:
 *   BlueprintHarness.fromBlueprint(path, opts) — loads agent.yaml
 *   BlueprintHarness.create(opts)              — inline organ list
 *
 * Example:
 *   const h = await BlueprintHarness.fromBlueprint("agent.yaml", {
 *     cwd: workspace,
 *     script: [
 *       step.toolCall("fs.read", { path: "src/auth.ts" }, "Found the bug."),
 *     ],
 *   });
 *   const reply = await h.send("What does login() do?");
 *   h.assertToolCalled("fs.read");
 *   h.assertToolCalledWith("fs.read", { path: "src/auth.ts" });
 *   h.dispose();
 *
 * Ref: ALE-SPC-17
 */

import { Agent, type BusObserver } from "@dpopsuev/alef-corpus";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import type { MotorEvent, NerveEvent, Organ } from "@dpopsuev/alef-spine";
import { BusEventRecorder } from "./index.js";
import type { ScriptStep } from "./script.js";
import { ScriptedLLMOrgan } from "./scripted-llm-organ.js";

// ---------------------------------------------------------------------------
// BlueprintHarness
// ---------------------------------------------------------------------------

export interface BlueprintHarnessOptions {
	/** Working directory for corpus organs. Required. */
	cwd: string;
	/** Script steps for ScriptedLLMOrgan. */
	script: ScriptStep[];
	/** Optional system prompt override. */
	systemPrompt?: string;
	/** Timeout per send() call in ms. Default: 30_000. */
	timeoutMs?: number;
}

export interface BlueprintFromFileOptions extends BlueprintHarnessOptions {
	/** Extra organs to load beyond what the blueprint declares. */
	extraOrgans?: Organ[];
}

export class BlueprintHarness {
	private readonly agent: Agent;
	private readonly dialog: DialogOrgan;
	private readonly recorder: BusEventRecorder;
	/** Exposed for advanced test scenarios (e.g. reset between turns). */
	readonly scriptedLlm: ScriptedLLMOrgan;
	private readonly timeoutMs: number;
	private _lastReply = "";

	private constructor(
		agent: Agent,
		dialog: DialogOrgan,
		recorder: BusEventRecorder,
		scriptedLlm: ScriptedLLMOrgan,
		timeoutMs: number,
	) {
		this.agent = agent;
		this.dialog = dialog;
		this.recorder = recorder;
		this.scriptedLlm = scriptedLlm;
		this.timeoutMs = timeoutMs;
	}

	// -------------------------------------------------------------------------
	// Factory — from a blueprint file
	// -------------------------------------------------------------------------

	/**
	 * Load a blueprint from a YAML file, instantiate its organs, inject
	 * ScriptedLLMOrgan. Real corpus organs execute (FsOrgan, ShellOrgan, etc.).
	 */
	static async fromBlueprint(blueprintPath: string, opts: BlueprintFromFileOptions): Promise<BlueprintHarness> {
		const { loadAgentDefinition } = await import("@dpopsuev/alef-agent-blueprint");
		const { materializeBlueprint } = await import("../../runner/src/materializer.js");

		const definition = loadAgentDefinition(blueprintPath);
		const materialized = materializeBlueprint(definition, { cwd: opts.cwd });

		const corpusOrgans = [...materialized.organs, ...(opts.extraOrgans ?? [])];
		return BlueprintHarness.create({ ...opts, organs: corpusOrgans });
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
		const scriptedLlm = new ScriptedLLMOrgan(opts.script);
		const agent = new Agent();

		const dialog = new DialogOrgan({
			sink: () => {},
			getTools: () => agent.tools,
			systemPrompt: opts.systemPrompt,
		});

		agent.load(dialog).load(scriptedLlm);
		for (const organ of opts.organs ?? []) {
			agent.load(organ);
		}

		agent.observe(recorder as BusObserver);
		agent.validate();

		return new BlueprintHarness(agent, dialog, recorder, scriptedLlm, opts.timeoutMs ?? 30_000);
	}

	// -------------------------------------------------------------------------
	// API
	// -------------------------------------------------------------------------

	/** Send a message to the agent and return its reply. */
	async send(text: string): Promise<string> {
		this.recorder.clear();
		const reply = await this.dialog.send(text, "human", this.timeoutMs);
		this._lastReply = reply;
		return reply;
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
