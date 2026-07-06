import "./providers/register-llm.js";

import { getApiProvider } from "./models/registry.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	StreamOptions,
} from "./types.js";
import type { AssistantMessageEventStream } from "./utils/event-stream.js";


/**
 *
 */
function resolveApiProvider(model: Model<Api>) {
	const provider = getApiProvider(model);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${model.api}`);
	}
	return provider;
}

/**
 *
 */
export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model);
	 
	return provider.stream(model, context, options);
}

/**
 *
 */
export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

/**
 *
 */
export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model);
	return provider.streamSimple(model, context, options);
}

/**
 *
 */
export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
