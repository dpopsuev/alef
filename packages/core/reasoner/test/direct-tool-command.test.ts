import { createAdapterCommandRouter, defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import { EventHub } from "@dpopsuev/alef-kernel/events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BusFixture, TurnDriver } from "../../testkit/src/index.js";
import { ToolCompleted, ToolStarted } from "../src/events.js";
import { createAgentLoop } from "../src/index.js";

const ECHO_TOOL = {
	name: "echo.run",
	description: "Echo a value.",
	inputSchema: z.object({ value: z.string() }),
	outputSchema: z.object({ echoed: z.string() }),
	version: 1,
} as const;

describe("direct tool commands", { tags: ["unit"] }, () => {
	const fixtures: BusFixture[] = [];
	const providers: Array<ReturnType<typeof registerFauxProvider>> = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.dispose();
		for (const provider of providers.splice(0)) provider.unregister();
	});

	it("returns tool results without command/result event pairing", async () => {
		const execute = vi.fn((value: string) => Promise.resolve({ echoed: value }));
		const adapter = defineAdapter(
			"echo",
			{ command: { "echo.run": typedAction(ECHO_TOOL, ({ payload }) => execute(payload.value)) } },
			{ description: "Echo test adapter.", directives: ["Use echo.run."] },
		);
		const commandRouter = createAdapterCommandRouter([adapter]);
		const faux = registerFauxProvider();
		providers.push(faux);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo.run", { value: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const fixture = new BusFixture();
		fixtures.push(fixture);
		const recorder = fixture.observe();
		const eventHub = new EventHub({ capacity: 8, concurrency: 1 });
		const facts: string[] = [];
		eventHub.subscribe(ToolStarted, (event) => {
			facts.push(event.type);
		});
		eventHub.subscribe(ToolCompleted, (event) => {
			facts.push(event.type);
		});
		fixture.mount(createAgentLoop({ model: faux.getModel(), commandRouter, eventHub }));
		const driver = new TurnDriver(fixture.bus, "llm.input", "llm.response", adapter.tools);

		await expect(driver.send("echo hello")).resolves.toBe("done");
		expect(execute).toHaveBeenCalledWith("hello");
		expect(recorder.command.some((event) => event.type === "echo.run")).toBe(false);
		expect(recorder.event.some((event) => event.type === "echo.run")).toBe(false);
		expect(recorder.notification.some((event) => event.type.startsWith("llm.tool-"))).toBe(false);
		expect(facts).toEqual(["tool.started", "tool.completed"]);
	});
});
