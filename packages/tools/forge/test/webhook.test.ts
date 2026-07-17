import { describe, expect, it } from "vitest";
import { domainEventsFromWebhook } from "../src/webhook.js";

describe("domainEventsFromWebhook", { tags: ["unit"] }, () => {
	it("maps opened pull_request to pr.opened", () => {
		const events = domainEventsFromWebhook({
			action: "opened",
			pull_request: {
				number: 7,
				title: "feat: factory roles",
				state: "open",
				html_url: "http://localhost:3000/alef/alef/pulls/7",
				head: { ref: "factory-roles" },
				base: { ref: "main" },
			},
			repository: { full_name: "alef/alef" },
		});
		expect(events).toEqual([
			{
				type: "pr.opened",
				payload: expect.objectContaining({
					repo: "alef/alef",
					number: 7,
					title: "feat: factory roles",
					head: "factory-roles",
					base: "main",
					action: "opened",
				}),
			},
		]);
	});

	it("maps review submitted to pr.reviewed", () => {
		const events = domainEventsFromWebhook({
			action: "submitted",
			pull_request: { number: 3, title: "x", state: "open" },
			repository: { full_name: "alef/alef" },
			review: { state: "APPROVED", body: "lgtm" },
		});
		expect(events[0]?.type).toBe("pr.reviewed");
		expect(events[0]?.payload.reviewState).toBe("APPROVED");
	});
});
