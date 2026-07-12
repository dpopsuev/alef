import { describe, expect, it } from "vitest";
import type { ImageContent, TextContent } from "@dpopsuev/alef-kernel/content";
import { AgentSession } from "../src/agent.js";
import type { SessionState } from "../src/contracts/session.js";

describe("Session content array support", () => {
	it("should accept string content (backward compatibility)", async () => {
		let receivedContent: string | (TextContent | ImageContent)[] | undefined;
		const session = new AgentSession({
			state: { id: "test", modelId: "test-model", contextWindow: 1000 } as SessionState,
			send: async (content) => {
				receivedContent = content;
				return "response";
			},
			receive: () => {},
			dispose: () => {},
		});

		await session.send("Hello, world!");
		expect(receivedContent).toBe("Hello, world!");
	});

	it("should accept content arrays with text", async () => {
		let receivedContent: string | (TextContent | ImageContent)[] | undefined;
		const session = new AgentSession({
			state: { id: "test", modelId: "test-model", contextWindow: 1000 } as SessionState,
			send: async (content) => {
				receivedContent = content;
				return "response";
			},
			receive: () => {},
			dispose: () => {},
		});

		const contentArray: (TextContent | ImageContent)[] = [{ type: "text", text: "Hello, world!" }];
		await session.send(contentArray);
		expect(receivedContent).toEqual(contentArray);
	});

	it("should accept content arrays with text and images", async () => {
		let receivedContent: string | (TextContent | ImageContent)[] | undefined;
		const session = new AgentSession({
			state: { id: "test", modelId: "test-model", contextWindow: 1000 } as SessionState,
			send: async (content) => {
				receivedContent = content;
				return "response";
			},
			receive: () => {},
			dispose: () => {},
		});

		const contentArray: (TextContent | ImageContent)[] = [
			{ type: "text", text: "What's in this image?" },
			{ type: "image", data: "base64data", mimeType: "image/jpeg" },
		];
		await session.send(contentArray);
		expect(receivedContent).toEqual(contentArray);
	});

	it("should support receive with string content", () => {
		let receivedContent: string | (TextContent | ImageContent)[] | undefined;
		const session = new AgentSession({
			state: { id: "test", modelId: "test-model", contextWindow: 1000 } as SessionState,
			send: async () => "response",
			receive: (content) => {
				receivedContent = content;
			},
			dispose: () => {},
		});

		session.receive("Hello, world!");
		expect(receivedContent).toBe("Hello, world!");
	});

	it("should support receive with content arrays", () => {
		let receivedContent: string | (TextContent | ImageContent)[] | undefined;
		const session = new AgentSession({
			state: { id: "test", modelId: "test-model", contextWindow: 1000 } as SessionState,
			send: async () => "response",
			receive: (content) => {
				receivedContent = content;
			},
			dispose: () => {},
		});

		const contentArray: (TextContent | ImageContent)[] = [
			{ type: "text", text: "What's in this image?" },
			{ type: "image", data: "base64data", mimeType: "image/jpeg" },
		];
		session.receive(contentArray);
		expect(receivedContent).toEqual(contentArray);
	});
});
