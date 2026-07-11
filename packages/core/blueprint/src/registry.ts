import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { createContextAssembler } from "@dpopsuev/alef-kernel/context-assembly";
import type { Api, Model } from "@dpopsuev/alef-ai/types";
import type { Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";

/**
 *
 */
export interface SubagentFactoryOptions {
	adapters: readonly Adapter[];
	onChunk?: (chunk: string) => void;
	onInnerEvent?: (callId: string, type: string, payload: Record<string, unknown>) => void;
	systemPrompt?: string;
	/** Soft token budget. When exceeded, a "wrap up" message is injected instead of hard-aborting. */
	tokenBudget?: number;
	/** Override the model for this subagent (e.g. 'claude-haiku-4-5' for cheap exploration). */
	modelOverride?: string;
}

/**
 *
 */
export type SubagentSession = Session;

/**
 *
 */
export type SubagentFactory = (opts: SubagentFactoryOptions) => SubagentSession;

/**
 *
 */
export interface BlueprintStackOptions {
	cwd: string;
	model: Model<Api>;
	getSignal?: () => AbortSignal | undefined;
	getParentDirectives?: () => Promise<string>;
	onRetry?: (attempt: number, reason: string) => void;
	sessionStore?: SessionStore;
	/**
	 * Pre-materialized domain adapters from the user's blueprint (--blueprint flag or adapters.yaml).
	 * When provided, the factory uses these instead of its default adapter set.
	 * Allows --blueprint to control which tools are exposed.
	 */
	domainAdapters?: Adapter[];
	/**
	 * Subagent factory injected by the runner. Creates lightweight inner agents
	 * for delegation strategies. Blueprint stacks must not construct this themselves —
	 * the runner owns Agent assembly and identity management.
	 */
	subagentFactory?: SubagentFactory;
	/**
	 * OCAP grant — directories adapters are allowed to access.
	 * Undefined = unrestricted. Propagated to orchestration adapter for child processes.
	 */
	writableRoots?: readonly string[];
}

/**
 *
 */
export interface BlueprintStack {
	adapters: Adapter[];
	contextAssembly: ReturnType<typeof createContextAssembler>;
}

/**
 *
 */
export type BlueprintFactory = (opts: BlueprintStackOptions) => Promise<BlueprintStack>;

/**
 *
 */
class BlueprintRegistry {
	private readonly _factories = new Map<string, BlueprintFactory>();
	private _default: BlueprintFactory | undefined;
	private _defaultName: string | undefined;

	register(name: string, factory: BlueprintFactory, options?: { isDefault?: boolean }): void {
		this._factories.set(name, factory);
		if (options?.isDefault) {
			this._default = factory;
			this._defaultName = name;
		}
	}

	resolve(name?: string): BlueprintFactory | undefined {
		return name ? this._factories.get(name) : this._default;
	}

	getDefaultName(): string | undefined {
		return this._defaultName;
	}

	list(): string[] {
		return [...this._factories.keys()];
	}
}

export const blueprintRegistry = new BlueprintRegistry();
