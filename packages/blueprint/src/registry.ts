import type { createContextAssemblyPipeline, Organ } from "@dpopsuev/alef-kernel";
import type { Api, Model } from "@dpopsuev/alef-llm";
import type { ISessionStore } from "@dpopsuev/alef-session";

export interface SubagentFactoryOptions {
	organs: readonly Organ[];
	onChunk?: (chunk: string) => void;
	systemPrompt?: string;
}

export type SubagentSession = {
	send(text: string, sender: string, timeoutMs: number): Promise<string>;
	dispose(): void;
};

export type SubagentFactory = (opts: SubagentFactoryOptions) => SubagentSession;

export interface BlueprintStackOptions {
	cwd: string;
	model: Model<Api>;
	getSignal?: () => AbortSignal | undefined;
	onRetry?: (attempt: number, reason: string) => void;
	sessionStore?: ISessionStore;
	/**
	 * Pre-materialized domain organs from the user's blueprint (--blueprint flag or organs.yaml).
	 * When provided, the factory uses these instead of its default organ set.
	 * Allows --blueprint to control which tools are exposed.
	 */
	domainOrgans?: Organ[];
	/**
	 * Subagent factory injected by the runner. Creates lightweight inner agents
	 * for delegation strategies. Blueprint stacks must not construct this themselves —
	 * the runner owns Agent assembly and identity management.
	 */
	subagentFactory?: SubagentFactory;
}

export interface BlueprintStack {
	organs: Organ[];
	pipeline: ReturnType<typeof createContextAssemblyPipeline>;
}

export type BlueprintFactory = (opts: BlueprintStackOptions) => Promise<BlueprintStack>;

class BlueprintRegistry {
	private readonly _factories = new Map<string, BlueprintFactory>();
	private _default: BlueprintFactory | undefined;

	register(name: string, factory: BlueprintFactory, options?: { isDefault?: boolean }): void {
		this._factories.set(name, factory);
		if (options?.isDefault) this._default = factory;
	}

	resolve(name?: string): BlueprintFactory | undefined {
		return name ? this._factories.get(name) : this._default;
	}

	list(): string[] {
		return [...this._factories.keys()];
	}
}

export const blueprintRegistry = new BlueprintRegistry();
