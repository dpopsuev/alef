/**
 * Production-readiness: OTLP export smoke, gate-off, TRACEPARENT inheritance.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	injectTraceContextIntoEnv,
	resetOTelForTests,
	setupOTel,
	snapshotSpansForTests,
	upgradeToSqliteExporter,
} from "../src/otel-setup.js";

interface OtlpMock {
	url: string;
	posts: number;
	close(): Promise<void>;
}

async function startOtlpMock(): Promise<OtlpMock> {
	const state = { posts: 0 };
	const server = http.createServer((req, res) => {
		if (req.method === "POST" && (req.url?.includes("/v1/traces") ?? false)) {
			state.posts += 1;
			req.resume();
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
			return;
		}
		res.writeHead(404);
		res.end();
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const addr = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${addr.port}`,
		get posts() {
			return state.posts;
		},
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs: number,
	label: string,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`timeout waiting for ${label}`);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
}

describe("OTLP production readiness", { tags: ["unit"] }, () => {
	let mock: OtlpMock | undefined;

	beforeEach(async () => {
		await resetOTelForTests();
	});

	afterEach(async () => {
		await resetOTelForTests();
		if (mock) {
			await mock.close();
			mock = undefined;
		}
	});

	it("exports spans to OTEL_EXPORTER_OTLP_ENDPOINT", async () => {
		mock = await startOtlpMock();
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = mock.url;

		setupOTel();
		await upgradeToSqliteExporter();

		const span = trace.getTracer("alef.prod-ready").startSpan("alef.command/fs.read");
		span.end();

		await waitFor(() => (mock?.posts ?? 0) > 0, 5_000, "OTLP POST");
		expect(mock.posts).toBeGreaterThan(0);

		const spans = await snapshotSpansForTests();
		expect(spans.some((s) => s.name === "alef.command/fs.read")).toBe(true);
	}, 15_000);

	it("does not POST when OTEL_EXPORTER_OTLP_ENDPOINT is unset", async () => {
		mock = await startOtlpMock();
		delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

		setupOTel();
		await upgradeToSqliteExporter();

		const span = trace.getTracer("alef.prod-ready").startSpan("alef.command/fs.write");
		span.end();

		await new Promise((r) => setTimeout(r, 400));
		expect(mock.posts).toBe(0);
	}, 10_000);

	it("child alef.session links to TRACEPARENT parent span id", async () => {
		const parentCtx = {
			traceId: "cccccccccccccccccccccccccccccccc",
			spanId: "dddddddddddddddd",
			traceFlags: TraceFlags.SAMPLED,
			isRemote: false,
		};
		const active = trace.setSpanContext(ROOT_CONTEXT, parentCtx);
		const env = injectTraceContextIntoEnv({}, "sess-parent", active);
		expect(env.TRACEPARENT).toBeTruthy();

		process.env.TRACEPARENT = env.TRACEPARENT!;
		process.env.ALEF_PARENT_SESSION_ID = "sess-parent";

		setupOTel();
		const child = trace.getTracer("alef.prod-ready").startSpan("alef.command/shell.exec");
		child.end();

		const spans = await snapshotSpansForTests();
		const session = spans.find((s) => s.name === "alef.session");
		expect(session).toBeDefined();
		expect(session!.parentSpanId).toBe(parentCtx.spanId);
		expect(session!.attributes["alef.parent.session_id"]).toBe("sess-parent");
	});

	it.todo("maps ProgressTelemetry tok/P onto OTLP GenAI/progress hierarchy");
	it.todo("agent.spawn process e2e: child SQLite spans walk to parent via TRACEPARENT");
});

describe("injectTraceContextIntoEnv contract", { tags: ["unit"] }, () => {
	it("preserves active context fields for spawn env", () => {
		const spanContext = {
			traceId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
			spanId: "ffffffffffffffff",
			traceFlags: TraceFlags.SAMPLED,
			isRemote: false,
		};
		const active = trace.setSpanContext(ROOT_CONTEXT, spanContext);
		const env = injectTraceContextIntoEnv({ FOO: "1" }, "parent-sess", active);
		expect(env.FOO).toBe("1");
		expect(env.TRACEPARENT).toContain(spanContext.traceId);
		expect(env.TRACEPARENT).toContain(spanContext.spanId);
		expect(env.ALEF_PARENT_SESSION_ID).toBe("parent-sess");
	});
});
