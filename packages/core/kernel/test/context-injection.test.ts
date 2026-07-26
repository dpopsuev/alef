import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createContextPipeline, describeMessageDelta, injectContextBlock } from "../src/context.js";

describe("injectContextBlock", { tags: ["unit"] }, () => {
	it("inserts after the system message", () => {
		const messages = injectContextBlock(
			[{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
			"injected",
			{ source: "plan" },
		);
		expect(messages).toEqual([
			{ role: "system", content: "sys" },
			{ role: "user", content: "injected" },
			{ role: "user", content: "hi" },
		]);
	});
});

describe("describeMessageDelta", { tags: ["unit"] }, () => {
	it("attributes newly inserted messages", () => {
		const before = [{ role: "system", content: "sys" }];
		const after = injectContextBlock(before, "plan body", { source: "plan" });
		expect(describeMessageDelta(before, after, "plan")).toEqual({
			source: "plan",
			chars: "plan body".length,
			preview: "plan body",
		});
	});
});

describe("ContextPipeline", { tags: ["unit"] }, () => {
	it("awaits stages in materialization order and reports injections", async () => {
		const pipeline = createContextPipeline();
		pipeline.addStage("first", async ({ messages }) => ({
			messages: injectContextBlock(messages, "FIRST", { source: "first" }),
		}));
		pipeline.addStage("second", async ({ messages }) => ({
			messages: injectContextBlock(messages, "SECOND", { source: "second" }),
		}));

		const result = await pipeline.run({
			messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
			tools: [],
			turn: 1,
		});

		expect(result.messages).toEqual([
			{ role: "system", content: "sys" },
			{ role: "user", content: "SECOND" },
			{ role: "user", content: "FIRST" },
			{ role: "user", content: "go" },
		]);
		expect(result.injections.map((injection) => injection.source)).toEqual(["first", "second"]);
	});

	it("collects stages and schemas directly from materialized adapters", async () => {
		const tool = { name: "fs.read", description: "Read", inputSchema: z.object({ path: z.string() }) };
		const pipeline = createContextPipeline([
			{
				name: "materialized",
				tools: [],
				subscriptions: { command: [], event: [], notification: [] },
				sources: [],
				contributions: {
					"context.stage": async ({ messages }) => ({
						messages: injectContextBlock(messages, "DIRECT", { source: "materialized" }),
					}),
					"schema-resolver": (name: string) => (name === tool.name ? tool : undefined),
				},
				mount: () => () => undefined,
			},
		]);

		const result = await pipeline.run({ messages: [], tools: [], turn: 1 });

		expect(result.messages).toEqual([{ role: "user", content: "DIRECT" }]);
		expect(pipeline.resolveSchema("fs.read")).toBe(tool);
	});
});
