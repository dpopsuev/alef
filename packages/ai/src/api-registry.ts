import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "./types.js";

export type ApiStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;

export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	api: TApi;
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
	/**
	 * Optional predicate that narrows which models this strategy handles.
	 * When multiple providers share the same api key (e.g. "anthropic-messages" for
	 * both the direct API and Vertex), each declares a match() that self-selects.
	 * Providers are evaluated in registration order; the first match wins.
	 * A provider without match() is treated as a fallback (always matches its api).
	 * Register specific strategies before fallback strategies.
	 */
	match?: (model: Model<Api>) => boolean;
}

interface ApiProviderInternal {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
	match?: (model: Model<Api>) => boolean;
}

type RegisteredApiProvider = {
	provider: ApiProviderInternal;
	sourceId?: string;
};

// Ordered list — registration order determines precedence when multiple providers
// share the same api key. First match wins. Use an array, not a Map, so that
// multiple strategies per api key can coexist.
const apiProviderRegistry: RegisteredApiProvider[] = [];

function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return stream(model as Model<TApi>, context, options as TOptions);
	};
}

function wrapStreamSimple<TApi extends Api>(
	api: TApi,
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return streamSimple(model as Model<TApi>, context, options);
	};
}

export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	apiProviderRegistry.push({
		provider: {
			api: provider.api,
			stream: wrapStream(provider.api, provider.stream),
			streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
			match: provider.match as ((model: Model<Api>) => boolean) | undefined,
		},
		sourceId,
	});
}

/**
 * Find the first registered provider that handles this model.
 * Evaluates api equality first, then match() if present.
 * Returns undefined if no provider claims the model.
 */
export function getApiProvider(model: Model<Api>): ApiProviderInternal | undefined {
	for (const { provider } of apiProviderRegistry) {
		if (provider.api !== model.api) continue;
		if (provider.match && !provider.match(model)) continue;
		return provider;
	}
	return undefined;
}

export function getApiProviders(): ApiProviderInternal[] {
	return apiProviderRegistry.map((entry) => entry.provider);
}

export function unregisterApiProviders(sourceId: string): void {
	let i = apiProviderRegistry.length;
	while (i-- > 0) {
		if (apiProviderRegistry[i]?.sourceId === sourceId) {
			apiProviderRegistry.splice(i, 1);
		}
	}
}

export function clearApiProviders(): void {
	apiProviderRegistry.length = 0;
}
