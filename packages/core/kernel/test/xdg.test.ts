import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("xdg migrateLegacyAlefHome", { tags: ["unit"] }, () => {
	const previous = {
		data: process.env.XDG_DATA_HOME,
		state: process.env.XDG_STATE_HOME,
		config: process.env.XDG_CONFIG_HOME,
		cache: process.env.XDG_CACHE_HOME,
		home: process.env.HOME,
	};

	afterEach(() => {
		for (const [key, value] of Object.entries({
			XDG_DATA_HOME: previous.data,
			XDG_STATE_HOME: previous.state,
			XDG_CONFIG_HOME: previous.config,
			XDG_CACHE_HOME: previous.cache,
			HOME: previous.home,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("moves legacy ~/.alef/alef.db into $XDG_DATA_HOME/alef when destination is empty", async () => {
		const root = mkdtempSync(join(tmpdir(), "alef-xdg-"));
		const fakeHome = join(root, "home");
		const dataHome = join(root, "data");
		const stateHome = join(root, "state");
		const configHome = join(root, "config");
		mkdirSync(fakeHome, { recursive: true });
		process.env.HOME = fakeHome;
		process.env.XDG_DATA_HOME = dataHome;
		process.env.XDG_STATE_HOME = stateHome;
		process.env.XDG_CONFIG_HOME = configHome;
		process.env.XDG_CACHE_HOME = join(root, "cache");

		const legacy = join(fakeHome, ".alef");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "alef.db"), "db-bytes");
		writeFileSync(join(legacy, "last-session.json"), '{"id":"x"}');
		mkdirSync(join(legacy, "sessions", "abc"), { recursive: true });
		writeFileSync(join(legacy, "sessions", "abc", "deadbeef.jsonl"), "{}\n");

		const { ensureAlefHome, databasePath, lastSessionPath, sessionsDir } = await import("../src/xdg.js");
		const result = ensureAlefHome();

		expect(result.moved.some((m) => m.includes("alef.db"))).toBe(true);
		expect(readFileSync(databasePath(), "utf-8")).toBe("db-bytes");
		expect(readFileSync(lastSessionPath(), "utf-8")).toBe('{"id":"x"}');
		expect(readFileSync(join(sessionsDir(), "abc", "deadbeef.jsonl"), "utf-8")).toBe("{}\n");

		const again = ensureAlefHome();
		expect(again.moved).toEqual([]);
	});

	it("places forge and code-intel under XDG data/cache with cwd hash", async () => {
		const root = mkdtempSync(join(tmpdir(), "alef-xdg-paths-"));
		process.env.HOME = join(root, "home");
		process.env.XDG_DATA_HOME = join(root, "data");
		process.env.XDG_CACHE_HOME = join(root, "cache");
		process.env.XDG_STATE_HOME = join(root, "state");
		process.env.XDG_CONFIG_HOME = join(root, "config");

		const { forgeDir, codeIntelGraphDbPath, cwdHash } = await import("../src/xdg.js");
		const cwd = "/tmp/workspace-example";
		const hash = cwdHash(cwd);
		expect(forgeDir(cwd)).toBe(join(root, "data", "alef", "forge", hash));
		expect(codeIntelGraphDbPath(cwd)).toBe(join(root, "cache", "alef", "code-intel", hash, "graph.db"));
		expect(forgeDir(cwd)).not.toContain(".alef");
		expect(codeIntelGraphDbPath(cwd)).not.toContain(".alef");
	});
});
