import { propagation, ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { injectTraceContextIntoEnv } from "../src/otel-setup.js";

describe("injectTraceContextIntoEnv", () => {
	it("writes TRACEPARENT and parent session from the given span context", () => {
		const spanContext = {
			traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			spanId: "bbbbbbbbbbbbbbbb",
			traceFlags: TraceFlags.SAMPLED,
			isRemote: false,
		};
		const active = trace.setSpanContext(ROOT_CONTEXT, spanContext);
		const env = injectTraceContextIntoEnv({ PATH: "/usr/bin" }, "sess-parent", active);

		expect(env.PATH).toBe("/usr/bin");
		expect(env.TRACEPARENT).toBe("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
		expect(env.ALEF_PARENT_SESSION_ID).toBe("sess-parent");

		const extracted = propagation.extract(ROOT_CONTEXT, {
			traceparent: env.TRACEPARENT!,
		});
		expect(trace.getSpanContext(extracted)?.traceId).toBe(spanContext.traceId);
		expect(trace.getSpanContext(extracted)?.spanId).toBe(spanContext.spanId);
	});
});
