import { afterAll, describe, expect, it } from "vitest";
import { type IsolatedLectorDaemon, startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.js";

describe("isolated Lector daemon smoke test", { tags: ["integration"], timeout: 30_000 }, () => {
	let daemon: IsolatedLectorDaemon | undefined;

	afterAll(async () => {
		await daemon?.stop();
	});

	it("boots a real Bun-run daemon and answers a health check", async () => {
		daemon = await startIsolatedLectorDaemon();
		expect(daemon.client).toBeDefined();
	});
});
