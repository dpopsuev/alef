import { homedir } from "node:os";
import { join } from "node:path";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-coding-agent";
import { createCodingAgentStack } from "@dpopsuev/alef-coding-agent";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { McpAdapter } from "@dpopsuev/alef-adapter-mcp-registry";
import { type SupervisorConfig, ToolSupervisor } from "@dpopsuev/alef-runtime";

const XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share");

export interface ResearchAgentOptions extends BlueprintStackOptions {
	scribeBinary?: string;
	scribeDbPath?: string;
	locusBinary?: string;
}

export async function createResearchAgentStack(
	opts: ResearchAgentOptions,
): Promise<BlueprintStack & { supervisor: ToolSupervisor }> {
	const scribeBinary = opts.scribeBinary ?? process.env.ALEF_SCRIBE_BIN ?? "scribe";
	const scribeDbPath = opts.scribeDbPath ?? join(XDG_DATA_HOME, "alef", "scribe.db");
	const locusBinary = opts.locusBinary ?? process.env.ALEF_LOCUS_BIN ?? "locus";

	const supervisorConfig: SupervisorConfig = {
		services: {
			scribe: {
				binary: scribeBinary,
				args: ["serve", "--db", scribeDbPath],
				transport: "stdio",
				restart: "permanent",
			},
			locus: {
				binary: locusBinary,
				args: ["serve", "--workspace", opts.cwd],
				transport: "stdio",
				restart: "permanent",
				dependsOn: ["scribe"],
				ingestURL: "scribe",
			},
		},
	};

	const codingStack = await createCodingAgentStack(opts);

	const supervisor = new ToolSupervisor(supervisorConfig, McpAdapter);

	const adapters: Adapter[] = [...codingStack.adapters];

	return {
		adapters,
		pipeline: codingStack.pipeline,
		supervisor,
	};
}
