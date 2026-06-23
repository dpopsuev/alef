/**
 * Framework contract: schema validation fires immediately on bad payload.
 *
 * defineAdapter auto-builds inputSchemas from tool definitions. dispatchCommandAction
 * must reject the payload and publish an error event BEFORE calling handle().
 * If this contract is broken, adapters that rely on type-safe payloads get
 * null/undefined at runtime and callers time out instead of seeing an error.
 */

import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { NerveFixture } from "@dpopsuev/alef-testkit";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("defineAdapter — schema validation contract", { tags: ["unit"] }, () => {
	it("fires error event immediately when command payload fails inputSchema", async () => {
		let handleCalled = false;

		const adapter = defineAdapter(
			"schema-test",
			{
				command: {
					"schema.op": typedAction(
						{
							name: "schema.op",
							description: "Op requiring a non-null text field.",
							inputSchema: z.object({ text: z.string() }),
						},
						async () => {
							handleCalled = true;
							return { ok: true };
						},
					),
				},
			},
			{
				description: "Schema validation test adapter.",
				directives: ["Use schema.op when asked to test schema validation."],
			},
		);

		const f = new NerveFixture();
		f.mount(adapter);

		const startedAt = Date.now();

		// Publish invalid payload — text is null, not a string
		const result = await f.call("schema.op", { text: null, toolCallId: "tc-schema-1" }, { timeoutMs: 500 });

		const elapsedMs = Date.now() - startedAt;

		// Must respond immediately — not after a 60s timeout
		expect(elapsedMs, "schema rejection must be immediate, not a timeout").toBeLessThan(200);

		// Must be an error event
		expect(result.isError, "schema rejection must set isError").toBe(true);
		expect(result.errorMessage, "error message must be human-readable retry hint").toMatch(
			/retry with corrected arguments/i,
		);
		expect(result.errorMessage, "error message must NOT use raw [InputValidation] prefix").not.toMatch(
			/\[InputValidation\]/i,
		);

		// handle() must never be called on invalid payload
		expect(handleCalled, "handle() must not be called when schema rejects").toBe(false);

		f.dispose();
	});

	it("calls handle() normally when payload satisfies inputSchema", async () => {
		let handleCalled = false;

		const adapter = defineAdapter(
			"schema-test-ok",
			{
				command: {
					"schema.ok": typedAction(
						{
							name: "schema.ok",
							description: "Op requiring a text field.",
							inputSchema: z.object({ text: z.string() }),
						},
						async (ctx) => {
							handleCalled = true;
							return { echo: ctx.payload.text };
						},
					),
				},
			},
			{
				description: "Schema validation happy-path adapter.",
				directives: ["Use schema.ok when asked to test schema validation happy path."],
			},
		);

		const f = new NerveFixture();
		f.mount(adapter);

		const result = await f.call("schema.ok", { text: "hello", toolCallId: "tc-schema-2" }, { timeoutMs: 500 });

		expect(result.isError).toBeFalsy();
		expect(result.payload.echo).toBe("hello");
		expect(handleCalled).toBe(true);

		f.dispose();
	});
});
