import { getDefaultResultOrder, setDefaultResultOrder } from "node:dns";
import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preferIpv4IfUnreachable } from "../src/boot/network.js";

describe("preferIpv4IfUnreachable", { tags: ["unit"] }, () => {
	let originalOrder: ReturnType<typeof getDefaultResultOrder>;

	beforeEach(() => {
		originalOrder = getDefaultResultOrder();
	});

	afterEach(() => {
		setDefaultResultOrder(originalOrder);
	});

	it("leaves DNS ordering untouched when the IPv6 target is reachable", async () => {
		const server = createServer(() => {});
		await new Promise<void>((resolve) => server.listen(0, "::1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("expected AddressInfo");

		await preferIpv4IfUnreachable({ host: "::1", port: address.port });

		expect(getDefaultResultOrder()).toBe(originalOrder);
		server.close();
	});

	it("prefers IPv4 when the IPv6 target refuses the connection", async () => {
		// Port 1 on loopback has nothing listening -- an immediate ECONNREFUSED,
		// standing in for a real network's "unreachable" verdict without waiting
		// out a timeout or depending on external connectivity.
		await preferIpv4IfUnreachable({ host: "::1", port: 1, timeoutMs: 200 });

		expect(getDefaultResultOrder()).toBe("ipv4first");
	});
});
