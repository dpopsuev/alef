import type { MotorEvent, Nerve, Organ, SenseEvent, SignalEvent } from "@dpopsuev/alef-spine";

// ---------------------------------------------------------------------------
// MockLLMOrgan
//
// Behaves like the real LLMOrgan: subscribes to Motor/llm_request, emits
// Motor/tool_call("send_message", { text }) with the same correlationId.
// Canned response text is configurable at construction time.
// ---------------------------------------------------------------------------

export class MockLLMOrgan implements Organ {
	readonly name = "mock-llm";
	readonly tools = [];

	constructor(private readonly cannedText: string = "mock response") {}

	mount(nerve: Nerve): () => void {
		return nerve.motor.on("llm_request", (event) => {
			if (event.type !== "llm_request") return;
			nerve.motor.emit({
				type: "tool_call",
				toolName: "send_message",
				args: { text: this.cannedText },
				correlationId: event.correlationId,
				timestamp: Date.now(),
			});
		});
	}
}

// ---------------------------------------------------------------------------
// BusEventRecorder
//
// An organ that subscribes to all event types on all 3 buses and records them.
// Load it into Corpus like any other organ: corpus.load(recorder).
// Use it to assert event sequences after a prompt() call.
// ---------------------------------------------------------------------------

export class BusEventRecorder implements Organ {
	readonly name = "bus-event-recorder";
	readonly tools = [];

	private readonly _sense: SenseEvent[] = [];
	private readonly _motor: MotorEvent[] = [];
	private readonly _signal: SignalEvent[] = [];

	get sense(): readonly SenseEvent[] {
		return this._sense;
	}
	get motor(): readonly MotorEvent[] {
		return this._motor;
	}
	get signal(): readonly SignalEvent[] {
		return this._signal;
	}

	mount(nerve: Nerve): () => void {
		const offs = [
			nerve.sense.on("user_message", (e) => void this._sense.push(e)),
			nerve.sense.on("tool_result", (e) => void this._sense.push(e)),
			nerve.motor.on("llm_request", (e) => void this._motor.push(e)),
			nerve.motor.on("tool_call", (e) => void this._motor.push(e)),
			nerve.motor.on("user_reply", (e) => void this._motor.push(e)),
			nerve.signal.on("signal", (e) => void this._signal.push(e)),
		];
		return () => {
			for (const off of offs) off();
		};
	}

	/** Assert a Sense event of the given type was emitted. Returns the first match. */
	assertSenseEmitted(type: SenseEvent["type"]): SenseEvent {
		const found = this._sense.find((e) => e.type === type);
		if (!found) {
			throw new Error(
				`Expected Sense/${type} to be emitted.\n` +
					`Sense events recorded: [${this._sense.map((e) => e.type).join(", ") || "none"}]`,
			);
		}
		return found;
	}

	/** Assert a Motor event of the given type was emitted. Returns the first match. */
	assertMotorEmitted(type: MotorEvent["type"]): MotorEvent {
		const found = this._motor.find((e) => e.type === type);
		if (!found) {
			throw new Error(
				`Expected Motor/${type} to be emitted.\n` +
					`Motor events recorded: [${this._motor.map((e) => e.type).join(", ") || "none"}]`,
			);
		}
		return found;
	}

	/** Assert a Motor/tool_call with a specific toolName was emitted. */
	assertToolCallEmitted(toolName: string): MotorEvent & { type: "tool_call" } {
		const found = this._motor.find(
			(e): e is MotorEvent & { type: "tool_call" } => e.type === "tool_call" && e.toolName === toolName,
		);
		if (!found) {
			const calls = this._motor
				.filter((e) => e.type === "tool_call")
				.map((e) => (e as { toolName: string }).toolName);
			throw new Error(
				`Expected Motor/tool_call("${toolName}") to be emitted.\n` +
					`Tool calls recorded: [${calls.join(", ") || "none"}]`,
			);
		}
		return found;
	}

	/** Assert Sense and Motor events with the same correlationId were both emitted. */
	assertCorrelationPaired(correlationId: string): void {
		const inSense = this._sense.some((e) => e.correlationId === correlationId);
		const inMotor = this._motor.some((e) => e.correlationId === correlationId);
		if (!inSense || !inMotor) {
			throw new Error(
				`Expected both Sense and Motor events with correlationId "${correlationId}".\n` +
					`Found in sense: ${inSense}, found in motor: ${inMotor}`,
			);
		}
	}

	/** Clear all recorded events. */
	clear(): void {
		this._sense.length = 0;
		this._motor.length = 0;
		this._signal.length = 0;
	}
}
