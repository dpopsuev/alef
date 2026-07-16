import { homedir } from "node:os";
import { join } from "node:path";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-coding-agent";
import { createCodingAgentStack } from "@dpopsuev/alef-coding-agent";
import { createFoundryRuntime, defineAdapterService } from "@dpopsuev/alef-foundry";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { McpAdapter } from "@dpopsuev/alef-tool-mcp-registry";
import type { ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import type { Supervisor } from "@dpopsuev/alef-supervisor/supervisor";

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
	return defineAdapterService({
		name,
		restart,
		shareable: true,
		dependsOn,
		createAdapter: () => McpAdapter.stdio(binary, args, name),
	});
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

	const foundry = createFoundryRuntime({ cwd: opts.cwd });
	foundry.register(
		mcpServiceDescriptor("scribe", scribeBinary, ["serve", "--db", scribeDbPath]),
	);
	foundry.register(
		mcpServiceDescriptor("locus", locusBinary, ["serve", "--workspace", opts.cwd], "permanent", ["scribe"]),
	);

	const codingStack = await createCodingAgentStack(opts);

	const adapters: Adapter[] = [...codingStack.adapters];

	return {
		adapters,
		contextAssembly: codingStack.contextAssembly,
		supervisor: foundry.supervisor,
	};
}
