import { homedir } from "node:os";
import { join } from "node:path";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-coding-agent";
import { createCodingAgentStack } from "@dpopsuev/alef-coding-agent";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { McpAdapter } from "@dpopsuev/alef-tool-mcp-registry";
import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { Supervisor } from "@dpopsuev/alef-supervisor/supervisor";

const XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share");

/**
 *
 */
export interface ResearchAgentOptions extends BlueprintStackOptions {
	scribeBinary?: string;
	scribeDbPath?: string;
	locusBinary?: string;
}

/**
 *
 */
function mcpServiceDescriptor(
	name: string,
	binary: string,
	args: string[],
	restart: "permanent" | "transient" = "permanent",
	dependsOn?: string[],
): ServiceDescriptor {
	return {
		name,
		restart,
		shareable: true,
		dependsOn,
		async create(_opts: ServiceCreateOpts): Promise<ManagedService> {
			const adapter = await McpAdapter.stdio(binary, args, name);
			return {
				name,
				restart,
				adapters: [adapter],
				tools: [...adapter.tools],
				start: () => Promise.resolve(),
				async stop() {
					await adapter.close?.();
				},
				health: () => Promise.resolve(true),
			};
		},
	};
}

/**
 *
 */
export async function createResearchAgentStack(
	opts: ResearchAgentOptions,
): Promise<BlueprintStack & { supervisor: Supervisor }> {
	const scribeBinary = opts.scribeBinary ?? process.env.ALEF_SCRIBE_BIN ?? "scribe";
	const scribeDbPath = opts.scribeDbPath ?? join(XDG_DATA_HOME, "alef", "scribe.db");
	const locusBinary = opts.locusBinary ?? process.env.ALEF_LOCUS_BIN ?? "locus";

	const supervisor = new Supervisor();
	supervisor.register(
		mcpServiceDescriptor("scribe", scribeBinary, ["serve", "--db", scribeDbPath]),
	);
	supervisor.register(
		mcpServiceDescriptor("locus", locusBinary, ["serve", "--workspace", opts.cwd], "permanent", ["scribe"]),
	);

	const codingStack = await createCodingAgentStack(opts);

	const adapters: Adapter[] = [...codingStack.adapters];

	return {
		adapters,
		contextAssembly: codingStack.contextAssembly,
		supervisor,
	};
}
