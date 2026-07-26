import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "@dpopsuev/alef-agent/create-agent-session";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@dpopsuev/alef-ai/faux";
import { createFoundryRuntime } from "@dpopsuev/alef-foundry";
import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import "@dpopsuev/alef-coding-agent";

import { loadAdapters } from "../src/boot/adapters.js";
import { parseArgs } from "../src/boot/args.js";

const SILENT_LOGGER = pino({ level: "silent" });

describe("coding agent walking skeleton", { tags: ["integration"] }, () => {
	const temporaryDirectories: string[] = [];
	const cleanups: Array<() => void | Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("selects the coding blueprint, invokes a model, executes a materialized tool, persists the turn, and returns the host reply", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "alef-coding-characterization-"));
		temporaryDirectories.push(cwd);
		writeFileSync(join(cwd, "characterization.txt"), "walking-skeleton-marker\n", "utf8");

		const modelContexts: string[] = [];
		const requestTool: FauxResponseFactory = (context) => {
			modelContexts.push(JSON.stringify(context.messages));
			return fauxAssistantMessage([fauxToolCall("fs.read", { path: "characterization.txt" })], {
				stopReason: "toolUse",
			});
		};
		const returnReply: FauxResponseFactory = (context) => {
			modelContexts.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("host-reply-marker");
		};
		const faux = registerFauxProvider({ models: [{ id: "coding-characterization-model" }] });
		faux.setResponses([requestTool, returnReply]);
		cleanups.push(() => faux.unregister());

		const store = await JsonlSessionStore.create(cwd);
		const foundry = createFoundryRuntime({ cwd });
		cleanups.push(() => foundry.stop());
		const args = {
			...parseArgs(["--blueprint", "alef-coding-agent"]),
			cwd,
			noTui: true,
		};
		const loaded = await loadAdapters(args, {}, SILENT_LOGGER, undefined, {
			resolveService: foundry.resolveService,
			sessionId: store.id,
		});
		const fileAdapter = loaded.adapters.find((adapter) => adapter.name === "fs");

		expect(loaded.blueprintName).toBe("alef-coding-agent");
		expect(fileAdapter).toBeDefined();

		const runtime = await createAgentSession({
			cwd,
			model: faux.getModel(),
			adapters: [fileAdapter!],
			toolDisclosure: "full",
			session: store,
			modelId: faux.getModel().id,
		});
		cleanups.push(() => runtime.dispose());

		const reply = await runtime.controller.send("characterization request", "human", 10_000);

		expect(reply).toBe("host-reply-marker");
		expect(modelContexts).toHaveLength(2);
		expect(modelContexts[0]).toContain("characterization request");
		expect(modelContexts[1]).toContain("walking-skeleton-marker");
		const events = await store.events();
		expect(events.map((event) => event.type)).toEqual(
			expect.arrayContaining(["llm.input", "tool.started", "tool.completed", "llm.response"]),
		);
		expect(JSON.stringify(events)).toContain("walking-skeleton-marker");
	});
});
