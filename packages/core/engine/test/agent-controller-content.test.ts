import { describe, expect, it, vi } from "vitest";
import type { ImageContent, TextContent } from "@dpopsuev/alef-ai/types";
import { AgentController } from "../src/agent-controller.js";
import type { Agent } from "../src/agent.js";

describe("AgentController content array support", () => {
	function createMockAgent(): Agent {
		const commandSubscribers = new Map<string, Set<(event: any) => void>>();
		const eventQueue: any[] = [];

		return {
			publishEvent: (event: any) => {
				eventQueue.push(event);
			},
			subscribeCommand: (eventType: string, handler: (event: any) => void) => {
				if (!commandSubscribers.has(eventType)) {
					commandSubscribers.set(eventType, new Set());
				}
				commandSubscribers.get(eventType)!.add(handler);
				return () => commandSubscribers.get(eventType)!.delete(handler);
			},
			signal: new AbortController().signal,
			asBus: () => ({} as any),
			load: () => {},
			unload: () => {},
			getAdapter: () => undefined,
		} as any as Agent;
	}

	it("should normalize string content to array", () => {
		const agent = createMockAgent();
		const controller = new AgentController(agent, { triggerEvent: "llm.input" });

		const publishSpy = vi.spyOn(agent, "publishEvent");

		controller.receive("Hello, world!");

		expect(publishSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "llm.input",
				payload: expect.objectContaining({
					text: "Hello, world!",
					content: [{ type: "text", text: "Hello, world!" }],
				}),
			})
		);

		controller.dispose();
	});

	it("should preserve content arrays", () => {
		const agent = createMockAgent();
		const controller = new AgentController(agent, { triggerEvent: "llm.input" });

		const publishSpy = vi.spyOn(agent, "publishEvent");

		const contentArray: (TextContent | ImageContent)[] = [
			{ type: "text", text: "What's in this image?" },
			{ type: "image", data: "base64data", mimeType: "image/jpeg" },
		];

		controller.receive(contentArray);

		expect(publishSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "llm.input",
				payload: expect.objectContaining({
					text: "What's in this image?",
					content: contentArray,
				}),
			})
		);

		controller.dispose();
	});

	it("should extract text from content array for backward compatibility", () => {
		const agent = createMockAgent();
		const controller = new AgentController(agent, { triggerEvent: "llm.input" });

		const publishSpy = vi.spyOn(agent, "publishEvent");

		const contentArray: (TextContent | ImageContent)[] = [
			{ type: "image", data: "base64data", mimeType: "image/jpeg" },
			{ type: "text", text: "Second text block" },
		];

		controller.receive(contentArray);

		expect(publishSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "llm.input",
				payload: expect.objectContaining({
					text: "Second text block", // First text block found
					content: contentArray,
				}),
			})
		);

		controller.dispose();
	});

	it("should handle content with no text blocks", () => {
		const agent = createMockAgent();
		const controller = new AgentController(agent, { triggerEvent: "llm.input" });

		const publishSpy = vi.spyOn(agent, "publishEvent");

		const contentArray: (TextContent | ImageContent)[] = [
			{ type: "image", data: "base64data", mimeType: "image/jpeg" },
		];

		controller.receive(contentArray);

		expect(publishSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "llm.input",
				payload: expect.objectContaining({
					text: "", // Empty when no text blocks
					content: contentArray,
				}),
			})
		);

		controller.dispose();
	});
});
