import type { Api, Model } from "@dpopsuev/alef-ai/types";
import type { RouterAdapter } from "@dpopsuev/alef-engine/http";
import type { Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import type { Logger } from "pino";
import type { AdapterLoadResult } from "./adapters.js";
import type { Args } from "./args.js";
import type { AlefConfig } from "./config.js";
import { buildIdentityContext, createLocalSession, type IdentityContext } from "./session.js";

/** Dependencies needed to assemble the local agent session. */
export interface AssembleSessionOptions {
	args: Args;
	cfg: AlefConfig;
	log: Logger;
	store: SessionStore;
	loaded: AdapterLoadResult;
	model: Model<Api>;
	storage: StorageFactory;
	identity?: IdentityContext;
}

/**
 * The fully assembled session: the live handle, its identity, and its HTTP surface setup.
 * Not an independent restart boundary -- nothing in production recreates it in place.
 */
export interface AssembledSession {
	readonly session: Session;
	readonly resolvedModelDisplay: string;
	readonly humanAddress: string;
	readonly agentAddress: string;
	readonly blueprintName: string;
	readonly blueprintPath: string | undefined;
	readonly setupSurface: () => Promise<{ port: number; router: RouterAdapter } | undefined>;
	dispose(): Promise<void>;
}

/** Assemble the local session directly -- identity, adapters, model, and agent -- with no service-registry indirection. */
export async function assembleSession(opts: AssembleSessionOptions): Promise<AssembledSession> {
	const identity = opts.identity ?? buildIdentityContext(opts.store);
	const {
		session: handle,
		resolvedModelDisplay,
		humanAddress,
		agentAddress,
		blueprintName,
		setupSurface,
	} = await createLocalSession(
		opts.args,
		opts.cfg,
		opts.log,
		opts.store,
		opts.loaded,
		opts.model,
		opts.storage,
		identity,
	);

	return {
		session: handle,
		resolvedModelDisplay,
		humanAddress,
		agentAddress,
		blueprintName,
		blueprintPath: opts.loaded.blueprintPath,
		setupSurface,
		dispose: () => handle.dispose(),
	};
}
