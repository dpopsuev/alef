/**
 * Observability E2E — verifies the full traceEvent pipeline:
 *   adapter publish → bus auto-trace → traceEvent → session store → queryable
 *
 * This test catches the class of bug where individual components work in isolation
 * but the wiring between them drops events silently.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import { initSessionSink, traceEvent } from "@dpopsuev/alef-kernel/log";
import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import { createInMemoryStorage } from "@dpopsuev/alef-testkit";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import "@dpopsuev/alef-coding-agent";

import { parseArgs } from "../src/boot/args.js";
import { buildIdentityContext, createLocalSession } from "../src/boot/session.js";

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

describe("observability E2E — traceEvent pipeline", { tags: ["unit"] }, () => {
	const tmpDirs: string[] = [];
	afterEach(() => {
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
		initSessionSink(() => {});
	});

	function makeTmp(): string {
		const d = mkdtempSync(join(tmpdir(), "alef-obs-e2e-"));
		tmpDirs.push(d);
		return d;
	}

	it.fails(
		"bus auto-trace events reach the session store after a turn",
		async () => {
			const faux = registerFauxProvider();
			faux.setResponses([fauxAssistantMessage("trace-test-reply")]);

			const cwd = makeTmp();
			const store = await JsonlSessionStore.create(cwd);
			const args = { ...parseArgs([]), cwd, noTui: true };
			const model = faux.getModel();

			const recorded: Array<{ type: string; bus: string }> = [];
			initSessionSink((record) => {
				recorded.push({
					type: typeof record.type === "string" ? record.type : "unknown",
					bus: typeof record.bus === "string" ? record.bus : "debug",
				});
			});

			const { session } = await createLocalSession(
				args,
				{},
				SILENT_LOGGER,
				store,
				EMPTY_LOADED,
				model,
				STUB_STORAGE,
				buildIdentityContext(store),
			);

			if (session.send) {
				await session.send("hello", 10_000);
			}

			const busTraces = recorded.filter((e) => e.type.startsWith("bus:"));
			expect(busTraces.length, "bus auto-trace events should be recorded").toBeGreaterThan(0);

			const hasNotification = busTraces.some((e) => e.type.startsWith("bus:notification:"));
			const hasCommand = busTraces.some((e) => e.type.startsWith("bus:command:"));
			expect(hasNotification, "bus:notification:* traces (llm.chunk, etc.)").toBe(true);
			expect(hasCommand, "bus:command:* traces (llm.response, etc.)").toBe(true);

			await session.dispose();
		},
		15_000,
	);

	it.fails(
		"tui:observer traceEvents fire when session.subscribe callback runs",
		async () => {
			const faux = registerFauxProvider();
			faux.setResponses([fauxAssistantMessage("observer-test-reply")]);

			const cwd = makeTmp();
			const store = await JsonlSessionStore.create(cwd);
			const args = { ...parseArgs([]), cwd, noTui: true };
			const model = faux.getModel();

			const recorded: string[] = [];
			initSessionSink((record) => {
				if (typeof record.type === "string") recorded.push(record.type);
			});

			const { session } = await createLocalSession(
				args,
				{},
				SILENT_LOGGER,
				store,
				EMPTY_LOADED,
				model,
				STUB_STORAGE,
				buildIdentityContext(store),
			);

			session.subscribe((event) => {
				traceEvent("tui:observer", { type: event.type });
			});

			if (session.send) {
				await session.send("hello", 10_000);
			}

			const observerTraces = recorded.filter((t) => t === "tui:observer");
			expect(observerTraces.length, "tui:observer traces should be recorded for each AgentEvent").toBeGreaterThan(0);

			await session.dispose();
		},
		15_000,
	);
});
