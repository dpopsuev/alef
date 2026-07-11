import type { Agent } from "@dpopsuev/alef-engine/agent";
import { AgentController } from "@dpopsuev/alef-engine/controller";
import { buildAdapterDirectives, createToolShellAdapter } from "@dpopsuev/alef-engine/catalog";
import { createRouterAdapter, type RouterAdapter } from "@dpopsuev/alef-engine/http";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { connectObservers } from "@dpopsuev/alef-agent/assemble";
import type { AgentEvent } from "@dpopsuev/alef-session/contracts";

/** Options for creating a remote session test harness. */
export interface RemoteSessionHarnessOptions {
	agent: Agent;
	adapters?: readonly Adapter[];
	port?: number;
}

/** Test harness providing a RouterAdapter and AgentController for HTTP tests. */
export interface RemoteSessionHarness {
	readonly router: RouterAdapter;
	readonly controller: AgentController;
	readonly host: string;
	readonly port: number;
	dispose(): void | Promise<void>;
}

/** Create a remote session harness with HTTP router for integration testing. */
export async function createRemoteHarness(opts: RemoteSessionHarnessOptions): Promise<RemoteSessionHarness> {
	const { agent } = opts;
	const adapters = opts.adapters ?? [];

	const toolShell = createToolShellAdapter({
		tools: adapters.flatMap((a) => a.tools),
		getTools: () => agent.tools,
		adapterDirectives: buildAdapterDirectives(adapters),
	});
	agent.load(toolShell);
	for (const adapter of adapters) agent.load(adapter);

	const controller = new AgentController(agent, {
		onReply: () => {},
	});

	const forward = (event: AgentEvent) => router.notifyAgent(event);

	const router = createRouterAdapter({
		port: opts.port ?? 0,
		triggerEvent: "llm.input",
		onMessage: (content) => controller.receive(content, "user"),
		getState: () => ({ modelId: "test-model", thinking: "off", contextWindow: 128_000 }),
		getHistory: () => [],
	});
	agent.load(router);

	const observers = new Set<(event: AgentEvent) => void>();
	observers.add(forward);
	connectObservers(agent, observers);

	await router.ready();
	const addr = router.address()!;

	return {
		router,
		controller,
		host: addr.host,
		port: addr.port,
		async dispose() {
			await agent.dispose();
		},
	};
}
