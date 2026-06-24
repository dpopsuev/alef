/**
 * Global OTel setup — imported once via vitest setupFiles before any test runs.
 *
 * OTel global provider is a singleton per process. Registering a second provider
 * is silently ignored by ProxyTracerProvider. So we register once here and export
 * the shared InMemorySpanExporter for EvalHarness to reset/read per run.
 */

import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";

export const globalSpanExporter = new InMemorySpanExporter();

const ctxMgr = new AsyncLocalStorageContextManager();
ctxMgr.enable();

const provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(globalSpanExporter)],
});

provider.register({ contextManager: ctxMgr });
