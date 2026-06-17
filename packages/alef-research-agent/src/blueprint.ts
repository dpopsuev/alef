import { homedir } from "node:os";
import { join } from "node:path";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-coding-agent";
import { createCodingAgentStack } from "@dpopsuev/alef-coding-agent";
import type { Organ } from "@dpopsuev/alef-kernel";
import { type FleetConfig, ServiceFleet } from "@dpopsuev/alef-runtime";

const XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share");

export interface ResearchAgentOptions extends BlueprintStackOptions {
	scribeBinary?: string;
	scribeDbPath?: string;
	locusBinary?: string;
}

export async function createResearchAgentStack(
	opts: ResearchAgentOptions,
): Promise<BlueprintStack & { fleet: ServiceFleet }> {
	const scribeBinary = opts.scribeBinary ?? join(homedir(), "Workspace/scribe/bin/scribe");
	const scribeDbPath = opts.scribeDbPath ?? join(XDG_DATA_HOME, "alef", "scribe.db");
	const locusBinary = opts.locusBinary ?? join(homedir(), "Workspace/locus/locus");

	const fleetConfig: FleetConfig = {
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

	const fleet = new ServiceFleet(fleetConfig);

	const organs: Organ[] = [...codingStack.organs];

	return {
		organs,
		pipeline: codingStack.pipeline,
		fleet,
	};
}
