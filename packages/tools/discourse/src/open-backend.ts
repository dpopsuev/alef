import type { AdapterLogger } from "@dpopsuev/alef-kernel/adapter";
import type { Client } from "@libsql/client";
import type { DiscourseBackend } from "./backend.js";
import { ensureDiscourseSchema } from "./ensure-schema.js";
import { scribeCallFromEnv } from "./http-scribe-call.js";
import type { ScribeArtifactCall } from "./scribe-backend.js";
import { ScribeDiscourseMirror } from "./scribe-backend.js";
import { SqliteDiscourseStore } from "./sqlite-store.js";

/** Options for opening a session-store discourse backend. */
export interface OpenDiscourseBackendOptions {
	client: Client;
	sessionId: string;
	scribeCall?: ScribeArtifactCall;
	scope?: string;
	logger?: AdapterLogger;
}

/** Open the session-store discourse backend, optionally wrapping a Scribe mirror. */
export async function openDiscourseBackend(opts: OpenDiscourseBackendOptions): Promise<DiscourseBackend> {
	await ensureDiscourseSchema(opts.client);
	const store: DiscourseBackend = new SqliteDiscourseStore(opts.client, opts.sessionId);
	const call = opts.scribeCall ?? scribeCallFromEnv();
	if (!call) return store;
	return new ScribeDiscourseMirror(store, call, opts.scope ?? "default", opts.logger);
}

/** Wrap an existing store with a Scribe mirror when a call is available. */
export function maybeMirrorToScribe(
	store: DiscourseBackend,
	opts?: { scribeCall?: ScribeArtifactCall; scope?: string; logger?: AdapterLogger },
): DiscourseBackend {
	const call = opts?.scribeCall ?? scribeCallFromEnv();
	if (!call) return store;
	return new ScribeDiscourseMirror(store, call, opts?.scope ?? "default", opts?.logger);
}

/** @deprecated Use maybeMirrorToScribe. */
export const maybeProjectToScribe = maybeMirrorToScribe;
