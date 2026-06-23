import type { BusMessage } from "@dpopsuev/alef-kernel";
import type { BusObserver } from "@dpopsuev/alef-runtime";

export class BusEventRecorder implements BusObserver {
	private readonly _motor: BusMessage[] = [];
	private readonly _sense: BusMessage[] = [];
	private readonly _signal: BusMessage[] = [];

	onMotorEvent(event: BusMessage): void {
		this._motor.push(event);
	}
	onSenseEvent(event: BusMessage): void {
		this._sense.push(event);
	}
	onSignalEvent(event: BusMessage): void {
		this._signal.push(event);
	}

	get motor(): readonly BusMessage[] {
		return this._motor;
	}
	get sense(): readonly BusMessage[] {
		return this._sense;
	}
	get signal(): readonly BusMessage[] {
		return this._signal;
	}

	assertSenseEmitted(type: string): BusMessage {
		const found = this._sense.find((e) => e.type === type);
		if (!found) {
			throw new Error(
				`Expected Sense/${type} to be emitted.\n` +
					`Sense events: [${this._sense.map((e) => e.type).join(", ") || "none"}]`,
			);
		}
		return found;
	}

	assertMotorEmitted(type: string): BusMessage {
		const found = this._motor.find((e) => e.type === type);
		if (!found) {
			throw new Error(
				`Expected Motor/${type} to be emitted.\n` +
					`Motor events: [${this._motor.map((e) => e.type).join(", ") || "none"}]`,
			);
		}
		return found;
	}

	assertToolCallEmitted(toolName: string): BusMessage {
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
	}
}
