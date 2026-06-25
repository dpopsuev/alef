import type { ApiProvider } from "./api-registry.js";
import type { Api, Provider } from "./types-providers.js";
import type { StreamOptions } from "./types-options.js";

export interface ProviderModelDefinition {
	id: string;
	name: string;
	provider: Provider;
	api: Api;
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number };
	thinkingLevel?: string;
}

export interface ProviderRegistration<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	providers: ApiProvider<TApi, TOptions>[];
	models: ProviderModelDefinition[];
}

export type ProviderFactory<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (opts: {
	apiKey?: string;
	baseUrl?: string;
}) => ProviderRegistration<TApi, TOptions> | Promise<ProviderRegistration<TApi, TOptions>>;
