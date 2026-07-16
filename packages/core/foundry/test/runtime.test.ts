import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileAgentDefinition } from "@dpopsuev/alef-blueprint/blueprints";
import type { ManagedService, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFoundryRuntime } from "../src/runtime.js";

const tempDirs: string[] = [];
const REPO_ROOT = resolve(import.meta.dirname, "../../../../");

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTmp(): string {
	const dir = mkdtempSync(join(REPO_ROOT, ".alef-foundry-"));
	tempDirs.push(dir);
	return dir;
}

describe("createFoundryRuntime", { tags: ["unit"] }, () => {
	it("starts and stops registered services through the supervisor", async () => {
		const start = vi.fn(async () => {});
		const stop = vi.fn(async () => {});
		const runtime = createFoundryRuntime({ cwd: "/tmp" });

		runtime.register({
			name: "session",
			restart: "temporary",
			shareable: true,
			async create(): Promise<ManagedService> {
				return {
					name: "session",
					restart: "temporary",
					adapters: [],
					tools: [],
					start,
					stop,
					health: async () => true,
				};
			},
		} satisfies ServiceDescriptor);

		await runtime.start();
		expect(start).toHaveBeenCalledOnce();
		expect(runtime.names()).toContain("session");

		await runtime.stop();
		expect(stop).toHaveBeenCalledOnce();
	});

	it("materializes service-backed adapters with runtime context", async () => {
		const dir = makeTmp();
		const adapterPath = join(dir, "service-backed.ts");
		writeFileSync(
			adapterPath,
			`
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";

const TOOL = {
	name: "service-backed.ping",
	description: "Ping from a service-backed adapter.",
	inputSchema: z.object({}),
};

export function createAdapter() {
	return defineAdapter(
		"service-backed",
		{
			command: {
				"service-backed.ping": typedAction(TOOL, async () =>
					withDisplay({ ok: true }, { text: "pong", mimeType: "text/plain" }),
				),
			},
		},
		{
			description: "Service-backed adapter test.",
			directives: ["Use service-backed.ping for runtime tests."],
		},
	);
}

export const service = {
	name: "service-backed",
	restart: "temporary",
	shareable: false,
	async create(opts) {
		if (opts.actorAddress !== "actor://tester") {
			throw new Error("missing actor context");
		}
		if (!opts.discussion || opts.discussion.topicId !== "foundry") {
			throw new Error("missing discussion context");
		}
		const adapter = createAdapter();
		return {
			name: "service-backed",
			restart: "temporary",
			adapters: [adapter],
			tools: [...adapter.tools],
			start: () => Promise.resolve(),
			stop: () => Promise.resolve(),
			health: () => Promise.resolve(true),
		};
	},
};
`,
			"utf-8",
		);

		const definition = compileAgentDefinition({
			name: "service-backed-agent",
			adapters: [{ path: adapterPath }],
		});
		const runtime = createFoundryRuntime({
			cwd: dir,
			actorAddress: "actor://tester",
			discussion: {
				forumId: "engineering",
				topicId: "foundry",
				topicTitle: "Foundry",
			},
		});

		const result = await runtime.materializeBlueprint(definition);

		expect(result.adapters).toHaveLength(1);
		expect(result.adapters[0]!.name).toBe("service-backed");
		expect(runtime.names()).toContain("service-backed");
		expect(runtime.tools().map((tool) => tool.name)).toContain("service-backed.ping");
	});

	it("ensures and stops individual services through the host surface", async () => {
		const stop = vi.fn(async () => {});
		const runtime = createFoundryRuntime({ cwd: "/tmp" });
		const descriptor = {
			name: "child-session",
			restart: "temporary",
			shareable: false,
			async create(): Promise<ManagedService> {
				return {
					name: "child-session",
					restart: "temporary",
					adapters: [],
					tools: [],
					start: () => Promise.resolve(),
					stop,
					health: () => Promise.resolve(true),
				};
			},
		} satisfies ServiceDescriptor;

		const service = await runtime.ensure(descriptor);

		expect(service.name).toBe("child-session");
		expect(runtime.get("child-session")).toBeDefined();

		await runtime.stopService("child-session");

		expect(stop).toHaveBeenCalledOnce();
		expect(runtime.get("child-session")).toBeUndefined();
	});
});
