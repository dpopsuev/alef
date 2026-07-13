import { describe, expect, it } from "vitest";
import { canonicalChannel, checkChannelViolation } from "../src/bus/channel-registry.js";

describe("bus channel registry", { tags: ["unit"] }, () => {
	it("llm.chunk belongs on notification", () => {
		expect(canonicalChannel("llm.chunk")).toBe("notification");
	});

	it("llm.response belongs on command", () => {
		expect(canonicalChannel("llm.response")).toBe("command");
	});

	it("llm.input belongs on event", () => {
		expect(canonicalChannel("llm.input")).toBe("event");
	});

	it("checkChannelViolation returns null for correct channel", () => {
		expect(checkChannelViolation("llm.chunk", "notification")).toBeNull();
	});

	it("checkChannelViolation returns expected channel for wrong channel", () => {
		expect(checkChannelViolation("llm.chunk", "command")).toBe("notification");
	});

	it("checkChannelViolation returns null for unregistered types", () => {
		expect(checkChannelViolation("custom.event", "command")).toBeNull();
	});

	it("all notification events are registered", () => {
		const notificationEvents = [
			"llm.chunk", "llm.thinking", "llm.tool-start", "llm.tool-end",
			"llm.tool-chunk", "llm.tool-stall", "llm.token-usage", "llm.result",
			"context.compact.request", "context.compacted", "context.overflow-recovery",
			"session.metadata.refresh", "plan.opened",
		];
		for (const type of notificationEvents) {
			expect(canonicalChannel(type), `${type} should be notification`).toBe("notification");
		}
	});
});

