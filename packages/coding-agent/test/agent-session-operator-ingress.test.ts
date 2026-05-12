import { fauxAssistantMessage } from "@dpopsuev/alef-ai";
import { afterEach, describe, expect, it } from "vitest";
import { boardPathToAddress } from "../src/board/types.js";
import type { Harness } from "./suite/harness.js";
import { createHarness } from "./suite/harness.js";

describe("AgentSession operator discourse ingress", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("mirrors operator prompts and root replies into discourse and preserves routing after relocation", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("working on release"), fauxAssistantMessage("looks good")]);

		await harness.session.prompt("Need release review");

		const initialTopic = harness.session.discourse.listTopics()[0];
		expect(initialTopic).toBeDefined();
		expect(initialTopic?.forum?.key).toBe("general");

		const initialThread = harness.session.discourse.readThread({ threadId: initialTopic!.thread.id });
		expect(initialThread.letters.map((letter) => `${letter.author}:${letter.body}`)).toEqual([
			"operator:Need release review",
			"gensec:working on release",
		]);

		const relocated = harness.session.discourse.relocateTopic({
			topicId: initialTopic!.topic.id,
			forumId: "release",
			relocatedBy: "gensec",
			reason: "triaged",
		});
		await harness.session.prompt("Ship it now");

		const routedAddress = boardPathToAddress(relocated.thread.address);
		const routedThread = harness.session.discourse.readThread({ address: routedAddress });
		expect(routedThread.topic.address.forumId).toBe("release");
		expect(routedThread.letters.map((letter) => `${letter.author}:${letter.body}`)).toEqual([
			"operator:Need release review",
			"gensec:working on release",
			"operator:Ship it now",
			"gensec:looks good",
		]);
		expect(routedThread.letters.every((letter) => letter.forumId === routedThread.topic.forumId)).toBe(true);
	});
});
