/**
 * Provider and API type definitions
 */

/**
 *
 */
export type KnownApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex";

/**
 *
 */
export type Api = KnownApi | (string & {});

/**
 *
 */
export type KnownImagesApi = "openrouter-images";

/**
 *
 */
export type ImagesApi = KnownImagesApi | (string & {});

/**
 *
 */
export type KnownProvider =
	| "amazon-bedrock"
	| "anthropic"
	| "google"
	| "google-vertex"
	| "openai"
	| "azure-openai-responses"
	| "openai-codex"
	| "deepseek"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "vercel-ai-gateway"
	| "zai"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "moonshotai"
	| "moonshotai-cn"
	| "huggingface"
	| "fireworks"
	| "together"
	| "opencode"
	| "opencode-go"
	| "kimi-coding"
	| "cloudflare-workers-ai"
	| "cloudflare-ai-gateway"
	| "xiaomi"
	| "xiaomi-token-plan-cn"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-sgp";
/**
 *
 */
export type Provider = KnownProvider | string;

/**
 *
 */
export type KnownImagesProvider = "openrouter";

/**
 *
 */
export type ImagesProvider = KnownImagesProvider | string;
