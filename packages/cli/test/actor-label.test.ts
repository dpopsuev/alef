import { describe, expect, it } from "vitest";
import { displayActorName } from "../src/client/actor-label.js";

describe("displayActorName", () => {
	it("strips the raw address prefix for chat labels", () => {
		expect(displayActorName("@dpopsuev", "you")).toBe("dpopsuev");
		expect(displayActorName("@lime", "alef")).toBe("lime");
	});

	it("falls back when the address is missing", () => {
		expect(displayActorName(undefined, "you")).toBe("you");
	});
});
