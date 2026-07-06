import type { BusMessage } from "@dpopsuev/alef-kernel/bus";
import type { BusObserver } from "@dpopsuev/alef-engine/agent";

/**
 *
 */
export class BusEventRecorder implements BusObserver {
	private readonly _motor: BusMessage[] = [];
	private readonly _sense: BusMessage[] = [];
	private readonly _signal: BusMessage[] = [];

	onCommand(event: BusMessage): void {
		this._motor.push(event);
	}
	onEvent(event: BusMessage): void {
		this._sense.push(event);
	}
	onNotification(event: BusMessage): void {
		this._signal.push(event);
	}

	get command(): readonly BusMessage[] {
		return this._motor;
	}
	get event(): readonly BusMessage[] {
		return this._sense;
	}
	get notification(): readonly BusMessage[] {
		return this._signal;
	}

	assertEventEmitted(type: string): BusMessage {
		const found = this._sense.find((e) => e.type === type);
		if (!found) {
			throw new Error(
				`Expected Event/${type} to be emitted.\n` +
					`Event messages: [${this._sense.map((e) => e.type).join(", ") || "none"}]`,
			);
		}
		return found;
	}

	assertCommandEmitted(type: string): BusMessage {
		const found = this._motor.find((e) => e.type === type);
		if (!found) {
			throw new Error(
				`Expected Command/${type} to be emitted.\n` +
					`Command messages: [${this._motor.map((e) => e.type).join(", ") || "none"}]`,
			);
		}
		return found;
	}

	assertToolCallEmitted(toolName: string): BusMessage {
		const found = this._motor.find((e) => {
			if (e.type !== "llm.tool_call") return false;
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- BusMessage lacks typed payload; narrowing to access toolName
			const p = (e as unknown as { payload?: { toolName?: string } }).payload;
			return p?.toolName === toolName;
		});
		if (!found) {
			const calls = this._motor
				.filter((e) => e.type === "llm.tool_call")
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- BusMessage lacks typed payload; narrowing to access toolName
				.map((e) => (e as unknown as { payload?: { toolName?: string } }).payload?.toolName ?? "?");
			throw new Error(
				`Expected Command/llm.tool_call("${toolName}").\n` + `Tool calls: [${calls.join(", ") || "none"}]`,
			);
		}
		return found;
	}

	assertCorrelationPaired(correlationId: string): void {
		const inSense = this._sense.some((e) => e.correlationId === correlationId);
		const inMotor = this._motor.some((e) => e.correlationId === correlationId);
		if (!inSense || !inMotor) {
			throw new Error(
				`Expected both Event and Command messages with correlationId "${correlationId}".\n` +
					`In event: ${inSense}, in command: ${inMotor}`,
			);
		}
	}

	clear(): void {
		this._motor.length = 0;
		this._sense.length = 0;
	}
}
