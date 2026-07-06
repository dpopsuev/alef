import type * as NodeOs from "node:os";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
} from "openai/resources/responses/responses.js";

import type { Context, Model, StreamOptions, Usage } from "../../types.js";
import { convertResponsesMessages, convertResponsesTools } from "../openai/responses-shared.js";

// NEVER convert to top-level runtime imports - breaks browser/Vite builds (web-ui)
let _os: typeof NodeOs | null = null;

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport: DynamicImport = (specifier) => import(specifier);
const NODE_OS_SPECIFIER = "node:" + "os";

if (typeof process !== "undefined" && (process.versions.node || process.versions.bun)) {
	void dynamicImport(NODE_OS_SPECIFIER).then((m) => {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dynamic import boundary
		_os = m as typeof NodeOs;
	});
}

// ============================================================================
// Configuration
// ============================================================================

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;
export const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

export const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";

// ============================================================================
// Request Body
// ============================================================================

/**
 *
 */
export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	previous_response_id?: string;
	input?: ResponseInput;
	tools?: OpenAITool[];
	tool_choice?: "auto";
	parallel_tool_calls?: boolean;
	temperature?: number;
	reasoning?: { effort?: string; summary?: string };
	service_tier?: ResponseCreateParamsStreaming["service_tier"];
	text?: { verbosity?: string };
	include?: string[];
	prompt_cache_key?: string;
	[key: string]: unknown;
}

// ============================================================================
// Auth & Headers
// ============================================================================

/**
 *
 */
export function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JWT parse boundary
		const payload = JSON.parse(atob(parts[1]));
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JWT claim access
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return -- JWT claim value
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

/**
 *
 */
export function createCodexRequestId(): string {
	if (typeof globalThis.crypto.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	return `codex_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 *
 */
function buildBaseCodexHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
): Headers {
	const headers = new Headers(initHeaders);
	for (const [key, value] of Object.entries(additionalHeaders ?? {})) {
		headers.set(key, value);
	}
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "alef");
	const userAgent = _os ? `alef (${_os.platform()} ${_os.release()}; ${_os.arch()})` : "alef (browser)";
	headers.set("User-Agent", userAgent);
	return headers;
}

/**
 *
 */
export function buildSSEHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
	sessionId?: string,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");

	if (sessionId) {
		headers.set("session_id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}

	return headers;
}

/**
 *
 */
export function buildWebSocketHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
	requestId: string,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.delete("accept");
	headers.delete("content-type");
	headers.delete("OpenAI-Beta");
	headers.delete("openai-beta");
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	headers.set("x-client-request-id", requestId);
	headers.set("session_id", requestId);
	return headers;
}

// ============================================================================
// URL Resolution
// ============================================================================

/**
 *
 */
export function resolveCodexUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

/**
 *
 */
export function resolveCodexWebSocketUrl(baseUrl?: string): string {
	const url = new URL(resolveCodexUrl(baseUrl));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

// ============================================================================
// Service Tier Pricing
// ============================================================================

/**
 *
 */
export function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-codex-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

/**
 *
 */
export function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-codex-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

/**
 *
 */
export function resolveCodexServiceTier(
	responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): ResponseCreateParamsStreaming["service_tier"] | undefined {
	if (responseServiceTier === "default" && (requestServiceTier === "flex" || requestServiceTier === "priority")) {
		return requestServiceTier;
	}
	return responseServiceTier ?? requestServiceTier;
}

// ============================================================================
// Request Building
// ============================================================================

/** Subset of options consumed by buildRequestBody — avoids circular import with the main module. */
interface BuildRequestBodyOptions extends StreamOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	textVerbosity?: "low" | "medium" | "high";
}

/**
 *
 */
export function buildRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: BuildRequestBodyOptions,
): RequestBody {
	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
	});

	const body: RequestBody = {
		model: model.id,
		store: false,
		stream: true,
		// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must fall through to default
		instructions: context.systemPrompt || "You are a helpful assistant.",
		input: messages,
		// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must fall through to default
		text: { verbosity: options?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: options?.sessionId,
		tool_choice: "auto",
		parallel_tool_calls: true,
	};

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	if (options?.serviceTier !== undefined) {
		body.service_tier = options.serviceTier;
	}

	if (context.tools && context.tools.length > 0) {
		body.tools = convertResponsesTools(context.tools, { strict: null });
	}

	if (options?.reasoningEffort !== undefined) {
		const effort =
			options.reasoningEffort === "none"
				? (model.thinkingLevelMap?.off ?? "none")
				: (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
		body.reasoning = {
			effort,
			summary: options.reasoningSummary ?? "auto",
		};
	}

	return body;
}
