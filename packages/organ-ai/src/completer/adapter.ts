import type { CompletionPort, CompletionRequest } from "@dpopsuev/alef-agent-runtime/platform";
import {
	type Api,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
} from "@dpopsuev/alef-ai";

export type CompletionAuthResult =
	| {
			ok: true;
			apiKey?: string;
			headers?: Record<string, string>;
	  }
	| {
			ok: false;
			error: string;
	  };

export type CompletionAuthResolver = (model: Model<Api>) => Promise<CompletionAuthResult>;

export interface CompleterOrganAdapterOptions {
	resolveAuth: CompletionAuthResolver;
	defaultOptions?: Pick<SimpleStreamOptions, "timeoutMs" | "maxRetries" | "maxRetryDelayMs">;
	headersForModel?: (model: Model<Api>) => Record<string, string> | undefined;
}

export class CompleterOrganAdapter implements CompletionPort {
	constructor(private readonly options: CompleterOrganAdapterOptions) {}

	async complete(request: CompletionRequest): Promise<AssistantMessageEventStream> {
		const auth = await this.options.resolveAuth(request.model);
		if (!auth.ok) {
			throw new Error(auth.error);
		}
		const modelHeaders = this.options.headersForModel?.(request.model);
		const requestHeaders = request.options?.headers;
		const headers =
			modelHeaders || auth.headers || requestHeaders
				? {
						...modelHeaders,
						...auth.headers,
						...requestHeaders,
					}
				: undefined;
		return streamSimple(request.model, request.context, {
			...this.options.defaultOptions,
			...request.options,
			apiKey: auth.apiKey,
			headers,
		});
	}
}

export function createCompleterOrganAdapter(options: CompleterOrganAdapterOptions): CompletionPort {
	return new CompleterOrganAdapter(options);
}
