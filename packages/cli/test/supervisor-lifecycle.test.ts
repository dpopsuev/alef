/**
 * Full lifecycle E2E test — boot → interact → exit.
 *
 * Guards a real regression: a fire-and-forget viewer.run() with no completion
 * signal leaves the entrypoint with no way to detect the viewer finished, so
 * it blocks on `await new Promise(() => {})` forever. runTui()'s `done`
 * promise is the fix, verified end-to-end here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import { createInMemoryStorage } from "@dpopsuev/alef-testkit";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import "@dpopsuev/alef-coding-agent";

import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import { parseArgs } from "../src/boot/args.js";
import { assembleSession } from "../src/boot/assemble-session.js";
import { runTui } from "../src/boot/run-tui.js";

const SILENT_LOGGER = pino({ level: "silent" });

const STUB_STORAGE: StorageFactory = createInMemoryStorage();
const EMPTY_LOADED = {
	adapters: [],
	blueprintModelId: undefined,
	blueprintName: undefined,
	blueprintSurfaces: [],
	blueprintUpgradePolicy: "rebuild_only" as const,
	blueprintPath: undefined,
	writableRoots: undefined,
};

describe("Full lifecycle", { tags: ["unit"] }, () => {
	const tmpDirs: string[] = [];

	afterEach(() => {
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function makeTmp(): string {
		const d = mkdtempSync(join(tmpdir(), "alef-lifecycle-"));
		tmpDirs.push(d);
		return d;
	}

	it("runTui exposes a done promise that resolves when the viewer exits", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("lifecycle test")]);

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const args = { ...parseArgs(["-p", "hello"]), cwd };
		const model = faux.getModel();

		const assembled = await assembleSession({
			args,
			cfg: {},
			log: SILENT_LOGGER,
			store,
			loaded: EMPTY_LOADED,
			model,
			storage: STUB_STORAGE,
		});

		const tui = runTui({ args, store, session: assembled });

		// Wait for done to resolve (print mode completes immediately after
		// delivering its one reply).
		const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000));
		const result = await Promise.race([tui.done.then(() => "done" as const), timeout]);
		expect(result).toBe("done");
	}, 15_000);
});
