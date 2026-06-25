# Alef Codebase: DRY and KISS Violations Analysis

**Date:** 2026-06-24  
**Scope:** packages/core/* and packages/tools/*  
**Priority:** High-impact violations first

---

## Executive Summary

The Alef codebase demonstrates strong architectural discipline overall, but contains several significant DRY (Don't Repeat Yourself) and KISS (Keep It Simple, Stupid) violations that increase maintenance burden and cognitive load. The most critical issues are:

1. **LLM Provider Streaming Boilerplate** - Massive duplication across 10+ provider files
2. **Adapter Factory Patterns** - Repetitive `withDisplay` wrapper patterns
3. **Error Handling Redundancy** - Identical try-catch-abort logic repeated
4. **Cache Key Generation** - Simple patterns without sufficient abstraction
5. **Tool Schema Definitions** - Verbose, duplicated metadata structures

---

## 1. LLM Provider Streaming Boilerplate (CRITICAL)

### Location
- `packages/core/llm/src/providers/anthropic.ts`
- `packages/core/llm/src/providers/google.ts`
- `packages/core/llm/src/providers/openai-responses.ts`
- `packages/core/llm/src/providers/openai-completions.ts`
- `packages/core/llm/src/providers/mistral.ts`
- `packages/core/llm/src/providers/google-vertex.ts`
- `packages/core/llm/src/providers/amazon-bedrock.ts`
- 10+ total files

### Violation
**DRY**: Identical stream initialization, error handling, and cleanup logic repeated across every provider.

### Evidence
Every provider file contains this pattern:

```typescript
export const streamXXX: StreamFunction<"provider-api", Options> = (
	model: Model<"provider-api">,
	context: Context,
	options?: Options,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			// Provider-specific logic here
			
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};
```

**Lines of duplication**: ~80 lines × 10 files = **~800 lines of copy-paste code**

### Impact
- **Maintainability**: Bug fixes require changes in 10+ files
- **Testing**: Each provider needs identical test coverage for shared logic
- **Onboarding**: New contributors must understand why pattern is repeated
- **Bug Surface**: Error handling bugs propagate to all providers

### Recommendation
Extract to a **streaming wrapper factory**:

```typescript
// packages/core/llm/src/stream-wrapper.ts
export function createStreamingProvider<TApi extends Api, TOptions extends StreamOptions>(
	processStream: (
		client: any,
		params: any,
		output: AssistantMessage,
		stream: AssistantMessageEventStream,
		options?: TOptions,
	) => Promise<void>,
): StreamFunction<TApi, TOptions> {
	return (model, context, options) => {
		const stream = new AssistantMessageEventStream();
		
		(async () => {
			const output = createEmptyAssistantMessage(model);
			try {
				await processStream(null, null, output, stream, options);
				validateAndFinalizeStream(output, options?.signal, stream);
			} catch (error) {
				handleStreamError(output, error, options?.signal, stream);
			}
		})();
		
		return stream;
	};
}
```

Then each provider becomes:

```typescript
export const streamAnthropic = createStreamingProvider<"anthropic-messages", AnthropicOptions>(
	async (_, __, output, stream, options) => {
		// Only provider-specific logic
		const client = createClient(model, apiKey, ...);
		for await (const event of iterateAnthropicEvents(response, options?.signal)) {
			// Process events
		}
	}
);
```

**Savings**: ~700 lines removed, single source of truth for stream lifecycle.

---

## 2. Adapter `withDisplay` Pattern Duplication

### Location
- `packages/tools/fs/src/adapter.ts`
- `packages/tools/shell/src/adapter.ts`
- `packages/tools/git/src/adapter.ts`
- `packages/tools/web/src/adapter.ts`
- `packages/tools/code-intel/src/adapter.ts`
- 20+ tool adapters

### Violation
**KISS**: Over-engineering display messages with redundant `withDisplay()` wrapper calls.

### Evidence
Every adapter action wraps results identically:

```typescript
// fs/src/adapter.ts
"fs.read": typedAction(
	FS_READ_TOOL,
	async (ctx) => {
		const result = await handleRead(ctx, options, tracker);
		const truncated = result.truncated as boolean;
		const outputLines = result.outputLines as number | undefined;
		const totalLines = result.totalLines as number;
		const truncNote = truncated
			? ` (truncated to ${outputLines ?? "?"} / ${totalLines} lines)`
			: ` (${totalLines} lines)`;
		return withDisplay(result, {
			text: `Read **${ctx.payload.path}**${truncNote}`,
			mimeType: "text/plain",
		});
	},
	{ shouldCache: () => true },
),

// git/src/adapter.ts
"git.status": typedAction(GIT_STATUS, async () => {
	const { execSync } = await import("node:child_process");
	const output = execSync("git status --short", { cwd: opts.cwd, encoding: "utf-8" });
	return withDisplay({ output }, { text: output || "(clean)", mimeType: "text/plain" });
}),

// web/src/adapter.ts
"web.search": typedAction(WEB_SEARCH_TOOL, async (ctx) => {
	const { query, numResults, engine, timeRange, topic } = ctx.payload;
	// ...
	return withLlmContent(
		JSON.stringify({ query, results }),
		{},
		{
			text: `Web search: **${query}** (${results.length} results)`,
			mimeType: "text/plain",
		},
	);
}),
```

**Pattern count**: 50+ instances across adapters

### Impact
- **Feature Envy**: Handlers manipulate display formatting more than core logic
- **Cognitive Load**: Every handler must remember to call `withDisplay` correctly
- **Inconsistency**: Display formats vary (some use markdown, some plain text)

### Recommendation
Extract display formatting to **decorators** or **conventions**:

```typescript
// Option A: Convention-based display (auto-infer from result)
const autoDisplay = <T>(result: T, defaultMessage: string): T & { _display } => {
	// Auto-generate display from result structure
	return { ...result, _display: { text: defaultMessage, mimeType: "text/plain" } };
};

// Option B: Declarative display metadata on tool definition
const FS_READ_TOOL = {
	name: "fs.read",
	description: "...",
	inputSchema: z.object({ /* ... */ }),
	displayFormatter: (ctx, result) => `Read **${ctx.payload.path}** (${result.totalLines} lines)`,
};

// Then handlers become:
"fs.read": typedAction(FS_READ_TOOL, handleRead),
```

**Savings**: Removes 100+ lines of boilerplate, centralizes display logic.

---

## 3. Cache Key and Invalidation Duplication

### Location
- `packages/core/kernel/src/adapter-cache.ts`
- `packages/tools/fs/src/adapter.ts` (WRITE_INVALIDATES constant)

### Violation
**DRY**: Cache invalidation patterns duplicated across write operations.

### Evidence

```typescript
// fs/src/adapter.ts (repeated for every write action)
const WRITE_INVALIDATES = ["fs.read", "fs.grep"];

"fs.write": typedAction(
	FS_WRITE_TOOL,
	async (ctx) => { /* ... */ },
	{ invalidates: () => WRITE_INVALIDATES },
),

"fs.edit": typedAction(
	FS_EDIT_TOOL,
	async (ctx) => { /* ... */ },
	{ invalidates: () => WRITE_INVALIDATES },
),

"fs.patch": typedAction(
	FS_PATCH_TOOL,
	async (ctx) => { /* ... */ },
	{ invalidates: () => WRITE_INVALIDATES },
),
```

Same pattern in shell, code-intel, and other adapters.

### Impact
- **Maintenance**: Adding a new cacheable read action requires updating all write actions
- **Missed Invalidations**: Easy to forget to add invalidation to new write operations

### Recommendation
**Declarative cache relationships**:

```typescript
// Define cache groups
const FS_CACHE_GROUP = {
	reads: ["fs.read", "fs.grep", "fs.find"],
	writes: ["fs.write", "fs.edit", "fs.patch"],
};

// Auto-wire invalidations
const { reads, writes } = createCacheGroup(FS_CACHE_GROUP);

// Actions declare membership, invalidation is automatic
"fs.read": typedAction(FS_READ_TOOL, handleRead, reads.cacheable()),
"fs.write": typedAction(FS_WRITE_TOOL, handleWrite, writes.invalidates()),
```

**Savings**: Removes 20+ lines per adapter, centralized cache topology.

---

## 4. Tool Schema Verbosity (KISS Violation)

### Location
- All `packages/tools/*/src/adapter.ts` files

### Violation
**KISS**: Overly verbose tool definitions with repetitive metadata.

### Evidence

```typescript
const FS_READ_TOOL = {
	name: "fs.read",
	description:
		"Read raw text from any file. Returns up to 2000 lines or 50KB; use offset/limit to paginate. Use format='hashline' for content-addressed line references (required before fs.hashline-edit).",
	inputSchema: z.object({
		path: z.string().min(1).describe("Path to the file (relative or absolute)"),
		offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
		limit: z.number().optional().describe("Maximum number of lines to read"),
		format: z
			.enum(["raw", "hashline"])
			.optional()
			.describe("Output format: raw (default) or hashline (line numbers + content hashes for editing)"),
	}),
};

const FS_GREP_TOOL = {
	name: "fs.grep",
	description:
		"Search file contents by regex or literal pattern using ripgrep. Returns matching lines with file paths and line numbers. To find callers of a specific symbol, use code.callers instead.",
	inputSchema: z.object({
		pattern: z.string().min(1).describe("Search pattern (regex or literal string)"),
		path: z.string().optional().describe("Directory or file to search (default: cwd)"),
		glob: z.string().optional().describe("Filter files by glob pattern, e.g. '*.ts'"),
		ignoreCase: z.boolean().optional().describe("Case-insensitive search (default: false)"),
		literal: z.boolean().optional().describe("Treat pattern as literal string (default: false)"),
		context: z.number().optional().describe("Lines before/after each match (default: 0)"),
		limit: z.number().optional().describe(`Max matches to return (default: ${DEFAULT_GREP_LIMIT})`),
		type: z.string().optional().describe("Filter by file type, e.g. 'ts', 'go', 'py'"),
		filesWithMatches: z.boolean().optional().describe("Return only file paths with matches"),
		countOnly: z.boolean().optional().describe("Return match count per file"),
	}),
};
```

**Repetition**: Similar patterns across 50+ tool definitions.

### Impact
- **Maintenance**: Schema changes require touching verbose definitions
- **Readability**: Hard to scan tool capabilities quickly
- **Cognitive Load**: New tool authors copy-paste instead of understanding patterns

### Recommendation
**Schema builder DSL**:

```typescript
const tool = toolBuilder("fs.read")
	.describe("Read raw text from any file. Returns up to 2000 lines or 50KB...")
	.param("path", z.string().min(1), "Path to the file (relative or absolute)")
	.param("offset", z.number().optional(), "Line number to start reading from (1-indexed)")
	.param("limit", z.number().optional(), "Maximum number of lines to read")
	.enum("format", ["raw", "hashline"], "Output format: raw (default) or hashline")
	.build();

// Or even more concise:
const FS_READ_TOOL = defineTool({
	name: "fs.read",
	description: "Read raw text from any file...",
	params: {
		path: { type: "string", required: true, description: "Path to the file" },
		offset: { type: "number", description: "Line number to start from" },
		limit: { type: "number", description: "Max lines to read" },
		format: { type: "enum", values: ["raw", "hashline"], description: "Output format" },
	},
});
```

**Savings**: 30-50% reduction in tool definition code.

---

## 5. Event Builder Redundancy

### Location
- `packages/core/kernel/src/event-builders.ts`

### Violation
**KISS**: Unnecessary abstraction layer over simple payload construction.

### Evidence

```typescript
export function buildEventResult(
	command: CommandMessage,
	payload: Record<string, unknown>,
	isError = false,
	errorMessage?: string,
): EventInput {
	const toolCallId = extractToolCallId(command.payload);
	return {
		type: command.type,
		correlationId: command.correlationId,
		payload: toolCallId ? { ...payload, toolCallId } : payload,
		isError,
		errorMessage,
	};
}

export function buildErrorResult(command: CommandMessage, message: string): EventInput {
	const toolCallId = extractToolCallId(command.payload);
	return {
		type: command.type,
		correlationId: command.correlationId,
		payload: toolCallId ? { toolCallId } : {},
		isError: true,
		errorMessage: message,
	};
}
```

These functions are called 10+ times in `adapter-dispatch.ts` when inline object construction would be clearer.

### Impact
- **Indirection**: Obscures what's actually being constructed
- **Maintenance**: Changes to event structure require touching multiple helpers

### Recommendation
**Inline construction** with helper for common cases:

```typescript
// Keep only the ID extractor
export function enrichWithToolCallId(
	payload: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	const toolCallId = extractToolCallId(source);
	return toolCallId ? { ...payload, toolCallId } : payload;
}

// Then at call sites:
bus.event.publish({
	type: command.type,
	correlationId: command.correlationId,
	payload: enrichWithToolCallId(result, command.payload),
	isError: false,
});
```

**Savings**: Removes 2 wrapper functions, improves clarity.

---

## 6. SSE Parsing Duplication (Anthropic Provider)

### Location
- `packages/core/llm/src/providers/anthropic.ts` (lines 300-450)

### Violation
**DRY**: Custom SSE parser implementation instead of using standard library.

### Evidence

```typescript
async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer);
			}
		}
		// ... 100+ more lines of SSE parsing
	}
}
```

### Impact
- **Reinventing Wheel**: SSE parsing is a solved problem
- **Bug Surface**: Custom parsers are prone to edge cases
- **Maintenance**: Must maintain SSE spec compliance manually

### Recommendation
Use **standard SSE library** or extract to `@dpopsuev/sse-parser`:

```typescript
import { parseSSE } from "@dpopsuev/sse-parser";

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	for await (const sse of parseSSE(response.body, { signal })) {
		if (sse.event === "error") throw new Error(sse.data);
		if (ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			yield parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
		}
	}
}
```

**Savings**: Removes ~200 lines, defers SSE complexity to tested library.

---

## 7. Handle* Function Pattern in Adapters

### Location
- `packages/tools/fs/src/adapter.ts`
- `packages/tools/shell/src/adapter.ts`
- `packages/tools/git/src/adapter.ts`

### Violation
**KISS**: Unnecessary `handleRead`, `handleWrite`, etc. abstractions.

### Evidence

```typescript
async function handleRead(
	ctx: { payload: { path: string; offset?: number; limit?: number; format?: string } },
	opts: FsAdapterOptions,
	tracker: FileTracker,
): Promise<Record<string, unknown>> {
	// Implementation
}

// Called from:
"fs.read": typedAction(
	FS_READ_TOOL,
	async (ctx) => {
		const result = await handleRead(ctx, options, tracker);
		return withDisplay(result, { /* ... */ });
	},
	{ shouldCache: () => true },
),
```

The `handleRead` function is called from exactly one place. Same for `handleWrite`, `handleEdit`, etc.

### Impact
- **Indirection**: Adds layer between definition and implementation
- **Feature Envy**: Handler functions access more adapter state than local data

### Recommendation
**Inline handlers** or use closure pattern:

```typescript
// Option A: Inline (for simple handlers)
"fs.read": typedAction(FS_READ_TOOL, async (ctx) => {
	const { path: filePath, offset, limit, format } = ctx.payload;
	const absolutePath = resolveFilePath(options.cwd, filePath);
	const rawBuf = await fsReadFile(absolutePath);
	// ... inline implementation
}, { shouldCache: () => true }),

// Option B: Closure factory (for complex handlers)
function createFsHandlers(opts: FsAdapterOptions, tracker: FileTracker) {
	return {
		read: async (ctx) => { /* ... */ },
		write: async (ctx) => { /* ... */ },
		// All handlers have access to opts, tracker via closure
	};
}

const handlers = createFsHandlers(options, tracker);

return defineAdapter("fs", {
	command: {
		"fs.read": typedAction(FS_READ_TOOL, handlers.read, { shouldCache: () => true }),
		"fs.write": typedAction(FS_WRITE_TOOL, handlers.write, { invalidates: () => WRITE_INVALIDATES }),
	}
});
```

**Savings**: Removes 5-10 function declarations per adapter, improves locality.

---

## 8. Guard Rule Pattern Duplication

### Location
- `packages/tools/shell/src/adapter.ts`

### Violation
**KISS**: Overly complex guard rule system for simple pattern matching.

### Evidence

```typescript
export interface GuardRule {
	test: (cmd: string) => boolean;
	reason: string;
}

export const DEFAULT_GUARD_RULES: readonly GuardRule[] = [
	{
		test: (cmd) => /\bgit\b/.test(cmd) && /--no-verify/.test(cmd),
		reason: "Blocked: --no-verify is not allowed...",
	},
	{
		test: (cmd) => /\bgit\s+reset\s+--hard\b/.test(cmd),
		reason: "Blocked: git reset --hard is destructive...",
	},
	// ... 5 more similar rules
];

export function guardCommand(command: string, rules: readonly GuardRule[] = DEFAULT_GUARD_RULES): GuardResult {
	for (const rule of rules) {
		if (rule.test(command)) return { blocked: true, reason: rule.reason };
	}
	return { blocked: false, reason: "" };
}
```

### Impact
- **Over-engineering**: Simple regex matching wrapped in interfaces
- **Feature Envy**: Guard system could be simplified to pattern list

### Recommendation
**Declarative pattern list**:

```typescript
const BLOCKED_PATTERNS: Array<[RegExp, string]> = [
	[/\bgit\b.*--no-verify/, "Blocked: --no-verify is not allowed..."],
	[/\bgit\s+reset\s+--hard\b/, "Blocked: git reset --hard is destructive..."],
	// ...
];

function checkBlockedPattern(cmd: string): string | null {
	for (const [pattern, reason] of BLOCKED_PATTERNS) {
		if (pattern.test(cmd)) return reason;
	}
	return null;
}

// Usage:
const blockReason = checkBlockedPattern(command);
if (blockReason) throw new Error(blockReason);
```

**Savings**: Removes interface, simplifies logic by 40%.

---

## 9. Provider `createClient` Duplication

### Location
- `packages/core/llm/src/providers/anthropic.ts`
- `packages/core/llm/src/providers/openai-responses.ts`
- `packages/core/llm/src/providers/openai-completions.ts`

### Violation
**DRY**: Nearly identical client initialization logic repeated.

### Evidence

```typescript
// anthropic.ts
function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string,
	interleavedThinking: boolean,
	useFineGrainedToolStreamingBeta: boolean,
	optionsHeaders?: Record<string, string>,
	dynamicHeaders?: Record<string, string>,
): { client: Anthropic; isOAuthToken: boolean } {
	// 150 lines of header merging, OAuth detection, beta flags
}

// openai-responses.ts
function createClient(
	model: Model<"openai-responses">,
	context: Context,
	apiKey?: string,
	optionsHeaders?: Record<string, string>,
	sessionId?: string,
) {
	// 100 lines of similar header merging, auth logic
}

// openai-completions.ts
function createClient(
	model: Model<"openai-completions">,
	context: Context,
	apiKey?: string,
	optionsHeaders?: Record<string, string>,
	sessionId?: string,
	compat: ResolvedOpenAICompletionsCompat,
) {
	// 120 lines of similar header merging, auth logic
}
```

### Impact
- **Maintenance**: Auth changes require updating 3+ files
- **Testing**: Same auth logic tested in multiple places
- **Bugs**: Inconsistent header handling across providers

### Recommendation
**Extract common client builder**:

```typescript
// packages/core/llm/src/client-builder.ts
export interface ClientBuilderOptions {
	provider: string;
	apiKey?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	sessionId?: string;
	betaFeatures?: string[];
	authType?: "apiKey" | "bearer" | "oauth";
}

export function buildClientHeaders(opts: ClientBuilderOptions): Record<string, string> {
	const headers: Record<string, string> = { ...opts.headers };
	
	// Common logic: session ID, auth, betas
	if (opts.sessionId) {
		headers["session_id"] = opts.sessionId;
		headers["x-client-request-id"] = opts.sessionId;
	}
	
	if (opts.betaFeatures?.length) {
		headers["anthropic-beta"] = opts.betaFeatures.join(",");
	}
	
	return headers;
}

// Then providers use:
const client = new Anthropic({
	apiKey,
	baseURL: model.baseUrl,
	defaultHeaders: buildClientHeaders({
		provider: model.provider,
		headers: optionsHeaders,
		betaFeatures: ["claude-code-20250219"],
	}),
});
```

**Savings**: Removes ~300 lines across providers, centralizes auth logic.

---

## 10. Speculative Generality: Unused Flexibility

### Location
- `packages/core/kernel/src/adapter-types.ts`
- `packages/core/kernel/src/buses.ts`

### Violation
**KISS**: Over-engineered type systems with unused flexibility.

### Evidence

```typescript
// Overly generic action maps
export type ActionMap = {
	[K: string]: CommandAction | EventAction;
};

export type CommandActionMap = {
	[K: string]: CommandAction;
};

export type EventActionMap = {
	[K: string]: EventAction;
};

// Complex cardinality system
export type PortCardinality = "zero-or-one" | "one" | "zero-or-many" | "one-or-many";

export interface PortDefinition {
	name: string;
	eventPattern: string;
	cardinality: PortCardinality;
}
```

**Actual usage**: Only `"zero-or-one"` cardinality is used in the codebase. The `"one"`, `"zero-or-many"`, and `"one-or-many"` options are never utilized.

### Impact
- **Cognitive Load**: Developers must understand unused cardinality options
- **Dead Code**: Type definitions that never execute
- **False Flexibility**: Implies future features that don't exist

### Recommendation
**Remove unused types**:

```typescript
// Simplified to actual usage
export type PortDefinition = {
	name: string;
	eventPattern: string;
	optional?: boolean; // Replaces cardinality with boolean
};
```

**Savings**: Removes 4 unused type variants, simplifies port system.

---

## Summary Table

| Violation | Location | Type | Impact | Est. Lines Saved |
|-----------|----------|------|--------|------------------|
| LLM Provider Streaming | `packages/core/llm/src/providers/*` | DRY | Critical | 700+ |
| Adapter Display Patterns | `packages/tools/*/src/adapter.ts` | KISS | High | 100+ |
| Cache Invalidation | `packages/tools/fs,shell,etc` | DRY | Medium | 50+ |
| Tool Schema Verbosity | `packages/tools/*/src/adapter.ts` | KISS | Medium | 200+ |
| Event Builders | `packages/core/kernel/src/event-builders.ts` | KISS | Low | 20 |
| SSE Parsing | `packages/core/llm/src/providers/anthropic.ts` | DRY | Medium | 200 |
| Handle* Functions | `packages/tools/*/src/adapter.ts` | KISS | Low | 50+ |
| Guard Rules | `packages/tools/shell/src/adapter.ts` | KISS | Low | 15 |
| Provider Client Init | `packages/core/llm/src/providers/*` | DRY | High | 300+ |
| Speculative Generality | `packages/core/kernel/src/*.ts` | KISS | Low | 10 |

**Total Estimated Savings**: 1,600+ lines  
**Maintenance Benefit**: Reduced surface area for bugs, faster onboarding

---

## Recommendations Priority

### P0 (Critical - Do First)
1. **Extract LLM streaming boilerplate** - Highest impact, 700+ lines saved
2. **Unify provider client initialization** - Security/auth bug risk
3. **Use standard SSE parser** - Bug surface reduction

### P1 (High Value)
4. **Simplify adapter display patterns** - Improve DX
5. **Cache invalidation declarative API** - Prevent cache bugs
6. **Tool schema builder DSL** - Reduce verbosity

### P2 (Nice to Have)
7. **Inline handle* functions** - Marginal improvement
8. **Simplify guard rules** - Minor cleanup
9. **Event builder simplification** - Low impact
10. **Remove unused cardinality types** - Cosmetic

---

## Additional Observations

### Strengths
- **Consistent Architecture**: Adapter pattern well-applied
- **Type Safety**: Excellent TypeScript usage
- **Testing**: Strong test coverage (not analyzed here)

### Minor Issues Not Listed
- Magic numbers scattered (timeouts, limits) instead of constants
- Some long functions (>100 lines) that could be split
- Inconsistent error message formatting

### Future Risks
- New providers will copy-paste existing patterns instead of using abstractions
- Cache invalidation bugs as tool count grows
- Display formatting inconsistency across adapters

---

**End of Analysis**
