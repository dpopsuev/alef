import { describe, expect, it } from "vitest";
import { serializeError } from "../src/providers/anthropic.js";

describe("serializeError", { tags: ["unit"] }, () => {
	it("returns a plain error's message", () => {
		expect(serializeError(new Error("boom"))).toBe("boom");
	});

	it("appends a syscall code not already present in the message", () => {
		const err = new Error("connection failed") as NodeJS.ErrnoException;
		err.code = "ECONNREFUSED";
		expect(serializeError(err)).toBe("connection failed — ECONNREFUSED");
	});

	it("walks gaxios-style .error cause chains", () => {
		const inner = new Error("connect ETIMEDOUT 142.250.0.1:443") as NodeJS.ErrnoException;
		inner.code = "ETIMEDOUT";
		const outer = new Error("request to https://oauth2.googleapis.com/token failed, reason: ") as Error & {
			error?: unknown;
		};
		outer.error = inner;
		expect(serializeError(outer)).toBe(
			"request to https://oauth2.googleapis.com/token failed, reason:  — connect ETIMEDOUT 142.250.0.1:443",
		);
	});

	it("unwraps AggregateError.errors[] with per-address code/syscall/family, not just the empty top-level message", () => {
		// Reproduces Node's autoSelectFamily (happy-eyeballs) failure shape: connecting to
		// oauth2.googleapis.com attempted both the IPv6 and IPv4 addresses, both failed, and
		// Node collapsed them into an AggregateError with an empty own .message.
		const v6 = new Error("connect ETIMEDOUT") as NodeJS.ErrnoException & {
			family?: string;
			address?: string;
		};
		v6.code = "ETIMEDOUT";
		v6.syscall = "connect";
		v6.address = "2404:6800:4003:c1a::5f";
		v6.family = "IPv6";

		const v4 = new Error("connect ETIMEDOUT") as NodeJS.ErrnoException & {
			family?: string;
			address?: string;
		};
		v4.code = "ETIMEDOUT";
		v4.syscall = "connect";
		v4.address = "142.250.0.1";
		v4.family = "IPv4";

		const outer = new Error("request to https://oauth2.googleapis.com/token failed, reason: ") as Error & {
			error?: unknown;
		};
		outer.error = new AggregateError([v6, v4], "");

		const result = serializeError(outer);
		expect(result).toContain("2404:6800:4003:c1a::5f (family IPv6)");
		expect(result).toContain("142.250.0.1 (family IPv4)");
	});

	it("passes through a non-Error string value as-is", () => {
		expect(serializeError("plain string")).toBe("plain string");
	});

	it("JSON-stringifies a non-Error, non-string thrown value", () => {
		expect(serializeError({ weird: true })).toBe('{"weird":true}');
	});

	it("returns JSON.stringify(error) when nothing is extractable", () => {
		expect(serializeError(null)).toBe("null");
	});
});
