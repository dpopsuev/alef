/**
 * Function type definitions for streaming and image generation
 */

import type { AssistantImages, ImagesContext, ImagesModel } from "./images.js";
import type { Context } from "./messages.js";
// Import Model from types-models to avoid circular dependency
// We import it here since functions depend on models
import type { Model } from "./models.js";
import type { ImagesOptions, StreamOptions } from "./options.js";
import type { Api, ImagesApi } from "./providers.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";

// Generic StreamFunction with typed options.
//
// Contract:
// - Must return an AssistantMessageEventStream.
// - Once invoked, request/model/runtime failures should be encoded in the
//   returned stream, not thrown.
// - Error termination must produce an AssistantMessage with stopReason
//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
/**
 *
 */
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

/**
 *
 */
export type ImagesFunction<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> = (
	model: ImagesModel<TApi>,
	context: ImagesContext,
	options?: TOptions,
) => Promise<AssistantImages>;
