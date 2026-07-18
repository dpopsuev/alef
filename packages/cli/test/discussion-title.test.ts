import { describe, expect, it } from "vitest";
import { deriveDiscussionTopicTitle } from "../src/boot/discussion.js";

function fakeStore(name: string | undefined): { name: () => string | undefined; id: string } {
	return { name: () => name, id: "sess-1" };
}

describe("deriveDiscussionTopicTitle", { tags: ["unit"] }, () => {
	it("is empty on boot when the session has no user-picked name", () => {
		expect(deriveDiscussionTopicTitle(fakeStore(undefined) as never, "/home/me/Workspace/alef")).toBe("");
		expect(deriveDiscussionTopicTitle(fakeStore("") as never, "/tmp/project")).toBe("");
		expect(deriveDiscussionTopicTitle(fakeStore("   ") as never, "/tmp/project")).toBe("");
	});

	it("uses the stored session name once picked", () => {
		expect(deriveDiscussionTopicTitle(fakeStore("Fix topic label lag") as never, "/tmp")).toBe("Fix topic label lag");
	});
});
