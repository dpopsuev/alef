import { describe, expect, it } from "vitest";
import { createContextAssembler, describeMessageDelta, injectContextBlock } from "../src/context.js";
import { InProcessBus } from "../src/bus/in-process-bus.js";

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

describe("createContextAssembler", { tags: ["unit"] }, () => {
	it("publishes context.injection when a stage adds messages", async () => {
		const bus = new InProcessBus();
		const assembler = createContextAssembler();
		assembler.addStage("plan", async ({ messages }) => ({
			messages: injectContextBlock(messages, "PLAN SUMMARY", { source: "plan" }),
		}));
		const unmount = assembler.mount(bus.asBus());

		const injection = new Promise<Record<string, unknown>>((resolve) => {
			const off = bus.asBus().notification.subscribe("context.injection", (event) => {
				off();
				resolve(event.payload);
			});
		});
		const assembled = new Promise<void>((resolve) => {
			const off = bus.asBus().event.subscribe("context.assemble", () => {
				off();
				resolve();
			});
		});

		bus.asBus().command.publish({
			type: "context.assemble",
			correlationId: "c1",
			payload: {
				messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
				turn: 1,
			},
		});

		await assembled;
		await expect(injection).resolves.toMatchObject({
			source: "plan",
			chars: "PLAN SUMMARY".length,
			preview: "PLAN SUMMARY",
		});
		unmount();
	});
});
