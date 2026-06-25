import { afterEach, describe, expect, it } from "vitest";
import { KeyringAuthStore } from "../src/keyring-auth-store.js";

describe("KeyringAuthStore", { tags: ["integration"] }, () => {
	const store = new KeyringAuthStore();
	const testProviders: string[] = [];

	afterEach(async () => {
		for (const p of testProviders.splice(0)) {
			await store.remove(p);
		}
	});

	it("set and get a key", async () => {
		const provider = `test-provider-${Date.now()}`;
		testProviders.push(provider);

		await store.set(provider, "sk-test-123");
		const key = await store.get(provider);
		expect(key).toBe("sk-test-123");
	});

	it("get returns undefined for missing provider", async () => {
		const key = await store.get("nonexistent-provider-xyz");
		expect(key).toBeUndefined();
	});

	it("remove deletes the key", async () => {
		const provider = `test-rm-${Date.now()}`;
		testProviders.push(provider);

		await store.set(provider, "to-delete");
		await store.remove(provider);
		const key = await store.get(provider);
		expect(key).toBeUndefined();
	});

	it("remove on nonexistent key does not throw", async () => {
		await expect(store.remove("never-existed")).resolves.toBeUndefined();
	});

	it("set overwrites existing key", async () => {
		const provider = `test-overwrite-${Date.now()}`;
		testProviders.push(provider);

		await store.set(provider, "old-key");
		await store.set(provider, "new-key");
		const key = await store.get(provider);
		expect(key).toBe("new-key");
	});

	it("list returns stored providers", async () => {
		const provider = `test-list-${Date.now()}`;
		testProviders.push(provider);

		await store.set(provider, "list-test");
		const entries = await store.list();
		const found = entries.find((e) => e.provider === provider);
		expect(found).toBeDefined();
		expect(found?.type).toBe("api_key");
	});
});
