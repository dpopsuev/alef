import type { AgentMessage } from "@dpopsuev/alef-agent-core";
import type {
	AgentMemoryPorts,
	SessionMemoryPort,
	WorkingMemoryEntry,
	WorkingMemoryPort,
} from "../../../coding-agent/src/core/platform/types.js";
import type { SessionManager } from "../../../coding-agent/src/core/session-manager.js";

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

export class InMemoryWorkingMemoryPort implements WorkingMemoryPort {
	private readonly values = new Map<string, unknown>();

	constructor(initialValues?: Record<string, unknown>) {
		for (const [key, value] of Object.entries(initialValues ?? {})) {
			this.values.set(key, cloneValue(value));
		}
	}

	get<T = unknown>(key: string): T | undefined {
		const value = this.values.get(key);
		if (value === undefined) {
			return undefined;
		}
		return cloneValue(value) as T;
	}

	set(key: string, value: unknown): void {
		this.values.set(key, cloneValue(value));
	}

	delete(key: string): boolean {
		return this.values.delete(key);
	}

	clear(): void {
		this.values.clear();
	}

	list(): WorkingMemoryEntry[] {
		return Array.from(this.values.entries()).map(([key, value]) => ({
			key,
			value: cloneValue(value),
		}));
	}

	snapshot(): Record<string, unknown> {
		return Object.fromEntries(this.list().map((entry) => [entry.key, entry.value]));
	}
}

export class SessionManagerMemoryPort implements SessionMemoryPort {
	constructor(
		private readonly sessionManager: SessionManager,
		private readonly getMessagesFn: () => AgentMessage[],
	) {}

	getMessages(): AgentMessage[] {
		return this.getMessagesFn().map((message) => cloneValue(message));
	}

	getEntries() {
		return this.sessionManager.getEntries().map((entry) => cloneValue(entry));
	}

	buildContext() {
		return cloneValue(this.sessionManager.buildSessionContext());
	}

	getSessionId(): string {
		return this.sessionManager.getSessionId();
	}

	getSessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}
}

export function createAgentMemoryPorts(options: {
	sessionManager: SessionManager;
	getMessages: () => AgentMessage[];
	workingMemory?: WorkingMemoryPort;
	workingMemorySeed?: Record<string, unknown>;
}): AgentMemoryPorts {
	return {
		session: new SessionManagerMemoryPort(options.sessionManager, options.getMessages),
		working: options.workingMemory ?? new InMemoryWorkingMemoryPort(options.workingMemorySeed),
	};
}
