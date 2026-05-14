import type { BusObserver } from "@dpopsuev/alef-corpus";
import type { CerebrumNerve, CerebrumOrgan, NerveEvent, ToolDefinition } from "@dpopsuev/alef-spine";

// ---------------------------------------------------------------------------
// MockLLMOrgan
//
// CerebrumOrgan: subscribes Sense/"llm.prompt", publishes Motor/"text.message".
// Canned response — no real LLM call.
// ---------------------------------------------------------------------------

export class MockLLMOrgan implements CerebrumOrgan {
	readonly kind = "cerebrum" as const;
	readonly name = "mock-llm";
	readonly tools: readonly ToolDefinition[] = [];

	constructor(private readonly cannedText: string = "mock response") {}

	mount(nerve: CerebrumNerve): () => void {
		return nerve.sense.subscribe("llm.prompt", (event) => {
			nerve.motor.publish({
				type: "text.message" as const,
				payload: { text: this.cannedText },
				correlationId: event.correlationId,
				timestamp: Date.now(),
			});
		});
	}
}

// ---------------------------------------------------------------------------
// BusEventRecorder
//
// Attaches to a Corpus via corpus.observe(recorder).
// Records all events on all 3 buses for assertion in tests.
// ---------------------------------------------------------------------------

export class BusEventRecorder implements BusObserver {
	private readonly _motor: NerveEvent[] = [];
	private readonly _sense: NerveEvent[] = [];
	private readonly _signal: NerveEvent[] = [];

	onMotorEvent(event: NerveEvent): void {
		this._motor.push(event);
	}
	onSenseEvent(event: NerveEvent): void {
		this._sense.push(event);
	}
	onSignalEvent(event: NerveEvent): void {
		this._signal.push(event);
	}

	get motor(): readonly NerveEvent[] {
		return this._motor;
	}
	get sense(): readonly NerveEvent[] {
		return this._sense;
	}
	get signal(): readonly NerveEvent[] {
		return this._signal;
	}

	assertSenseEmitted(type: string): NerveEvent {
		const found = this._sense.find((e) => e.type === type);
		if (!found) {
			throw new Error(
				`Expected Sense/${type} to be emitted.\n` +
					`Sense events: [${this._sense.map((e) => e.type).join(", ") || "none"}]`,
			);
		}
		return found;
	}

	assertMotorEmitted(type: string): NerveEvent {
		const found = this._motor.find((e) => e.type === type);
		if (!found) {
			throw new Error(
				`Expected Motor/${type} to be emitted.\n` +
					`Motor events: [${this._motor.map((e) => e.type).join(", ") || "none"}]`,
			);
		}
		return found;
	}

	assertToolCallEmitted(toolName: string): NerveEvent {
		const found = this._motor.find((e) => {
			if (e.type !== "llm.tool_call") return false;
			const p = (e as unknown as { payload?: { toolName?: string } }).payload;
			return p?.toolName === toolName;
		});
		if (!found) {
			const calls = this._motor
				.filter((e) => e.type === "llm.tool_call")
				.map((e) => (e as unknown as { payload?: { toolName?: string } }).payload?.toolName ?? "?");
			throw new Error(
				`Expected Motor/llm.tool_call("${toolName}").\n` + `Tool calls: [${calls.join(", ") || "none"}]`,
			);
		}
		return found;
	}

	assertCorrelationPaired(correlationId: string): void {
		const inSense = this._sense.some((e) => e.correlationId === correlationId);
		const inMotor = this._motor.some((e) => e.correlationId === correlationId);
		if (!inSense || !inMotor) {
			throw new Error(
				`Expected both Sense and Motor events with correlationId "${correlationId}".\n` +
					`In sense: ${inSense}, in motor: ${inMotor}`,
			);
		}
	}

	clear(): void {
		this._motor.length = 0;
		this._sense.length = 0;
		this._signal.length = 0;
	}
}
