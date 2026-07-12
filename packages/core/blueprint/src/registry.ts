import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { createContextAssembler } from "@dpopsuev/alef-kernel/context-assembly";
import type { Api, Model } from "@dpopsuev/alef-ai/types";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { SubagentFactory } from "@dpopsuev/alef-engine/subagent-port";

export type { SubagentFactory, SubagentFactoryOptions, SubagentSession } from "@dpopsuev/alef-engine/subagent-port";

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
