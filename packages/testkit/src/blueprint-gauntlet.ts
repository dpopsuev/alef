/**
 * BlueprintGauntlet \u2014 story-based blueprint test harness.
 *
 * A typed harness for structured e2e blueprint testing organized as Stories.
 * Each Story creates a fresh gauntlet with its own TempDir, stub organs, and
 * scripted LLM. Stories are independent and self-contained.
 *
 * Mirrors Tako testkit/acceptance/SDLCGauntlet pattern:
 *   - NewGauntlet(t) creates a fully wired test environment
 *   - Run() / Resume() walk the agent turn loop
 *   - assertToolCalled() / assertToolCalledWith() verify organ behavior
 *   - withStubOrgan() replaces a real organ with a stub for isolation
 *
 * Gate/approval workflows are stubbed for now \u2014 the organ-orchestration integration
 * will wire real approval gates when ALE-SPC-35 (ContextOrgan) is complete.
 *
 * Ref: ALE-TSK-328
 */

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@dpopsuev/alef-corpus";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { type ExecutionStrategy, gimpedOrgan, type Organ } from "@dpopsuev/alef-spine";
import { BusEventRecorder, ScriptedReasoner, type ScriptStep, step } from "./index.js";

export interface GauntletOptions {
	/** Organs to mount. Required. */
	organs: Organ[];
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
 *   organs: [createFsOrgan({ cwd: workspace })],
 *   script: [
 *     step.text("Here is the file."),
 *   ],
 * });
 * const reply = await g.send("Read README.md");
 * g.assertToolCalled("fs.read");
 * await g.dispose();
 */
export class BlueprintGauntlet implements ExecutionStrategy {
	readonly workspace: string;
	private readonly agent: Agent;
	private readonly dialog: DialogOrgan;
	private readonly recorder: BusEventRecorder;
	readonly scriptedLlm: ScriptedReasoner;
	private readonly timeoutMs: number;

	private constructor(
		workspace: string,
		agent: Agent,
		dialog: DialogOrgan,
		recorder: BusEventRecorder,
		scriptedLlm: ScriptedReasoner,
		timeoutMs: number,
	) {
		this.workspace = workspace;
		this.agent = agent;
		this.dialog = dialog;
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
		const dialog = new DialogOrgan();
		const recorder = new BusEventRecorder();

		const agent = new Agent();
		for (const organ of [...opts.organs, dialog, scriptedLlm]) {
			agent.load(organ);
		}
		agent.observe(recorder);

		return new BlueprintGauntlet(workspace, agent, dialog, recorder, scriptedLlm, opts.timeoutMs ?? 30_000);
	}

	// ---------------------------------------------------------------------------
	// Interaction
	// ---------------------------------------------------------------------------

	/** Send a message to the agent and await the reply. */
	async send(text: string): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`BlueprintGauntlet.send() timed out after ${this.timeoutMs}ms`)),
				this.timeoutMs,
			);

			this.dialog
				.send(text)
				.then((reply) => {
					clearTimeout(timer);
					resolve(reply);
				})
				.catch((err) => {
					clearTimeout(timer);
					reject(err);
				});
		});
	}

	// ---------------------------------------------------------------------------
	// Story isolation \u2014 replace a real organ with a gimped stub
	// ---------------------------------------------------------------------------

	/**
	 * Returns a new GauntletOptions with the named organ replaced by a GimpedOrgan.
	 * Use to establish ablation baselines within a story:
	 *
	 * @example
	 * const opts = { organs: [fsOrgan, shellOrgan], script: [...] };
	 * const full = await BlueprintGauntlet.create(opts);
	 * const baseline = await BlueprintGauntlet.create(
	 *   BlueprintGauntlet.withGimpedOrgan(opts, "fs")
	 * );
	 * // Compare full vs baseline to measure fsOrgan's contribution.
	 */
	static withGimpedOrgan(opts: GauntletOptions, organName: string): GauntletOptions {
		return {
			...opts,
			organs: opts.organs.map((o) => (o.name === organName ? gimpedOrgan(organName) : o)),
		};
	}

	// ---------------------------------------------------------------------------
	// Assertions
	// ---------------------------------------------------------------------------

	/** Assert a tool was called at least once during the run. */
	assertToolCalled(toolName: string): void {
		const motorEvents = this.recorder.motor;
		const found = motorEvents.some((e) => e.type === toolName);
		if (!found) {
			const calls = [...new Set(motorEvents.map((e) => e.type))].join(", ") || "none";
			throw new Error(`Expected tool "${toolName}" to be called.\nMotor events: [${calls}]`);
		}
	}

	/** Assert a tool was NOT called during the run. */
	assertToolNotCalled(toolName: string): void {
		const found = this.recorder.motor.some((e) => e.type === toolName);
		if (found) {
			throw new Error(`Expected tool "${toolName}" NOT to be called, but it was.`);
		}
	}

	/** Assert a tool was called with a specific payload (partial match). */
	assertToolCalledWith(toolName: string, expectedPayload: Record<string, unknown>): void {
		const calls = this.recorder.motor.filter((e) => e.type === toolName);
		if (calls.length === 0) {
			throw new Error(`Expected tool "${toolName}" to be called, but it was not.`);
		}
		const matched = calls.some((e) => {
			const p = (e as unknown as { payload?: Record<string, unknown> }).payload ?? {};
			return Object.entries(expectedPayload).every(([k, v]) => JSON.stringify(p[k]) === JSON.stringify(v));
		});
		if (!matched) {
			const payloads = calls
				.map((e) => JSON.stringify((e as unknown as { payload?: unknown }).payload))
				.join("\n  ");
			throw new Error(
				`Tool "${toolName}" was called but not with expected payload ${JSON.stringify(expectedPayload)}.\n  Actual payloads:\n  ${payloads}`,
			);
		}
	}

	/** Assert no tools were called (reply-only turn). */
	assertNoToolsCalled(): void {
		const toolEvents = this.recorder.motor.filter((e) => e.type !== "dialog.message");
		if (toolEvents.length > 0) {
			const names = [...new Set(toolEvents.map((e) => e.type))].join(", ");
			throw new Error(`Expected no tool calls, but got: [${names}]`);
		}
	}

	/** Returns all Motor event types observed during the run. */
	get calledTools(): string[] {
		return [...new Set(this.recorder.motor.map((e) => e.type))];
	}

	/** Returns all recorded motor events. */
	get motorEvents() {
		return this.recorder.motor;
	}

	/** Returns all recorded sense events. */
	get senseEvents() {
		return this.recorder.sense;
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
