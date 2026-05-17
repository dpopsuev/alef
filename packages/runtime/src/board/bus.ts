import { randomUUID } from "node:crypto";
import type { EventLog } from "./event-log.js";
import type { OrganInvokeV1Data, OrganResultV1Data } from "./protocol.js";

// ---------------------------------------------------------------------------
// OrganResult — the typed return value from an organ action.
// ---------------------------------------------------------------------------

export interface OrganResult {
	/** True when the action succeeded; false on error. */
	ok: boolean;
	/** The actual output — organ-specific shape. */
	content: unknown;
	/** Byte length of content when serialized. Used for protocol audit. */
	contentLength: number;
	/** Error message when ok === false. Must be non-empty when present. */
	error?: string;
}

// ---------------------------------------------------------------------------
// OrganHandler — what organs register to handle actions.
// ---------------------------------------------------------------------------

/**
 * A function registered by an organ to handle its actions.
 * @param action        - action name (e.g. "grep", "find", "exec")
 * @param args          - validated input arguments
 * @param correlationId - request correlation ID for tracing
 * @param signal        - abort signal; organ should cancel/kill work when aborted
 * @param onUpdate      - optional streaming callback; call with partial results during execution
 */
export type OrganHandler = (
	action: string,
	args: Record<string, unknown>,
	correlationId: string,
	signal?: AbortSignal,
	onUpdate?: (partial: OrganResult) => void,
) => Promise<OrganResult>;

// ---------------------------------------------------------------------------
// Organ — the EDA contract every organ must satisfy.
//
// An organ is a unit that:
//  - declares its name and the actions it handles
//  - mounts itself to an OrganBus (subscribes to invoke events)
//  - returns an unmount function for clean teardown
//
// Organs never call back into the corpus directly. All communication goes
// through the bus. If an organ is not mounted, the action is unavailable —
// the bus will throw an explicit error, not silently bypass.
// ---------------------------------------------------------------------------

/** @deprecated Use Organ from buses.ts (Pub-Sub model). Legacy RPC-over-bus organ. */
export interface BusOrgan {
	/** Canonical organ name. Must match ^[a-z][a-z0-9_.-]*$ */
	readonly name: string;
	/** Actions this organ handles (e.g. ["grep", "find", "ls"]). */
	readonly actions: readonly string[];
	/**
	 * Mount this organ onto the bus. The organ subscribes to its actions.
	 * @returns unmount function — call to detach cleanly.
	 */
	mount(bus: OrganBus): () => void;
}

// ---------------------------------------------------------------------------
// OrganBus — the routing and audit surface.
//
// The corpus calls invoke(). Organs call handle() during mount().
// The bus emits organ.invoke.v1 / organ.result.v1 events for every
// invocation so the EventLog gets a complete audit trail.
// ---------------------------------------------------------------------------

export interface OrganBus {
	/**
	 * Invoke an organ action and wait for the result.
	 * Emits organ.invoke.v1 before dispatch and organ.result.v1 after.
	 * Throws if no organ is mounted for the given organName.
	 * @param signal   - forwarded to the organ handler for cooperative cancellation
	 * @param onUpdate - streaming callback; the organ calls this with partial results during execution
	 */
	invoke(
		organ: string,
		action: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: OrganResult) => void,
	): Promise<OrganResult>;

	/**
	 * Register an action handler for an organ. Called by organs during mount().
	 * Only one handler per organName is allowed — last registration wins.
	 * @returns unregister function.
	 */
	handle(organName: string, handler: OrganHandler): () => void;

	/** Returns true when a handler is registered for the given organ name. */
	isMounted(organName: string): boolean;

	/** Returns the names of all currently mounted organs. */
	mountedOrgans(): string[];
}

// ---------------------------------------------------------------------------
// InProcessOrganBus — the single production implementation.
//
// Routes organ.invoke.v1 events synchronously to registered handlers.
// Uses the EventLog for audit (invoke + result events) so the DomainEventSpine
// sees every invocation without any separate instrumentation.
// ---------------------------------------------------------------------------

export class InProcessOrganBus implements OrganBus {
	private readonly handlers = new Map<string, OrganHandler>();

	/**
	 * @param log - EventLog to emit audit events into.
	 *              Pass the same MemLog used by RuntimeDomainEventSpine so
	 *              the spine's correlation tracking works out of the box.
	 */
	constructor(private readonly log: EventLog) {}

	async invoke(
		organName: string,
		action: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: OrganResult) => void,
	): Promise<OrganResult> {
		const handler = this.handlers.get(organName);
		if (!handler) {
			const mounted = this.mountedOrgans();
			throw new Error(
				`Organ not mounted: "${organName}". Mounted: [${mounted.length > 0 ? mounted.join(", ") : "none"}]. ` +
					`Add "${organName}" to the blueprint organ list.`,
			);
		}

		const correlationId = randomUUID();

		// Audit: invoke event (before execution so the spine can track pending correlations)
		this.log.emit({
			kind: "organ.invoke.v1",
			source: "corpus",
			direction: "outbound",
			traceId: correlationId,
			data: {
				schemaVersion: "v1",
				plane: "data",
				lane: "motory",
				seam: "corpus.organ",
				correlationId,
				organ: organName,
				action,
				args,
				source: "llm_tool_call",
				gate: "requested",
			} satisfies OrganInvokeV1Data,
		});

		let result: OrganResult;
		try {
			result = await handler(action, args, correlationId, signal, onUpdate);
		} catch (err) {
			result = {
				ok: false,
				content: null,
				contentLength: 0,
				error: err instanceof Error ? err.message : String(err),
			};
		}

		// Audit: result event
		this.log.emit({
			kind: "organ.result.v1",
			source: "corpus",
			direction: "inbound",
			traceId: correlationId,
			data: {
				schemaVersion: "v1",
				plane: "data",
				lane: "sensory",
				seam: "corpus.organ",
				correlationId,
				organ: organName,
				action,
				status: result.ok ? "ok" : "error",
				isError: !result.ok,
				contentLength: result.contentLength,
				gate: result.ok ? "executed" : "error",
				...(result.error !== undefined ? { error: result.error } : {}),
			} satisfies OrganResultV1Data,
		});

		return result;
	}

	handle(organName: string, handler: OrganHandler): () => void {
		this.handlers.set(organName, handler);
		return () => {
			if (this.handlers.get(organName) === handler) {
				this.handlers.delete(organName);
			}
		};
	}

	isMounted(organName: string): boolean {
		return this.handlers.has(organName);
	}

	mountedOrgans(): string[] {
		return [...this.handlers.keys()];
	}
}
