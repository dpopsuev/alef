import type { AdapterLogger } from "@dpopsuev/alef-kernel/adapter";
import type { Client } from "@libsql/client";
import { CapabilityDiscourseBackend } from "./capability-backend.js";
import { InMemoryDiscourseSubscriptions } from "./domain/memory-store.js";
import type { DiscourseProjection } from "./domain/ports.js";
import type { ProjectionStatus } from "./domain/types.js";
import { ensureDiscourseSchema } from "./ensure-schema.js";
import { scribeCallFromEnv } from "./http-scribe-call.js";
import { type ScribeArtifactCall, ScribeDiscourseProjection } from "./scribe-projection.js";
import { SqliteCapabilityDiscourseStore } from "./sqlite-capability-store.js";

/** Options for opening a board-scoped discourse backend. */
export interface OpenDiscourseBackendOptions {
	client: Client;
	/** Durable conversation-space identity, independent of any one process/session lifetime. */
	boardId: string;
	scribeCall?: ScribeArtifactCall;
	scope?: string;
	logger?: AdapterLogger;
}

/** Emit credential-safe projection health through the adapter logger. */
function observeProjection(logger: AdapterLogger | undefined, status: ProjectionStatus): void {
	const fields = {
		component: "discourse-projection",
		projectionId: status.projectionId,
		state: status.state,
		checkpoint: status.checkpoint,
		latestSequence: status.latestSequence,
		pending: status.pending,
	};
	if (status.state === "failed") logger?.warn(fields, "discourse projection failed");
	else logger?.debug(fields, "discourse projection advanced");
}

/** Resolve optional external projections from adapter-owned configuration. */
function projections(
	opts: Pick<OpenDiscourseBackendOptions, "scribeCall" | "scope" | "logger">,
): DiscourseProjection[] {
	const call = opts.scribeCall ?? scribeCallFromEnv();
	return call ? [new ScribeDiscourseProjection(call, opts.scope ?? "default", opts.logger)] : [];
}

/** Open the durable board-scoped capability backend and optional outbox projections. */
export async function openDiscourseBackend(opts: OpenDiscourseBackendOptions): Promise<CapabilityDiscourseBackend> {
	await ensureDiscourseSchema(opts.client);
	return new CapabilityDiscourseBackend({
		boardId: opts.boardId,
		store: new SqliteCapabilityDiscourseStore(opts.client, opts.boardId),
		subscriptions: new InMemoryDiscourseSubscriptions(),
		projections: projections(opts),
		observeProjection: (status) => observeProjection(opts.logger, status),
	});
}

/** Open the standalone capability backend and optional outbox projections. */
export function openInMemoryDiscourseBackend(
	opts: Omit<OpenDiscourseBackendOptions, "client" | "boardId"> = {},
): CapabilityDiscourseBackend {
	return new CapabilityDiscourseBackend({
		projections: projections(opts),
		observeProjection: (status) => observeProjection(opts.logger, status),
	});
}
