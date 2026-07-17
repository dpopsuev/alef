import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BootstrapBlueprintId } from "@dpopsuev/alef-blueprint/bootstrap";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

/**
 *
 */
function loadPrompt(fileName: string): string {
	return readFileSync(join(PROMPTS_DIR, fileName), "utf-8").trim();
}

/**
 * Factory line role profiles registered on agent.run.
 */
export type FactoryRoleProfile =
	| "coordinator"
	| "director"
	| "supervisor"
	| "worker.coder"
	| "worker.reviewer"
	| "worker.quality"
	| "gensec"
	| "2sec";

/**
 *
 */
export type FactoryRoleKind = "line" | "staff" | "worker";

/**
 *
 */
export interface FactoryRoleDefinition {
	profile: FactoryRoleProfile;
	kind: FactoryRoleKind;
	/** Use coding SBOM adapters when true. */
	codingTools: boolean;
	role: { category: string; roleId: string; blueprintId: string };
	systemPrompt: string;
}

/** Legacy GenSec/2Sec staff — kept for bootstrap compatibility. */
export const STAFF_BOOTSTRAP_ROLES: ReadonlyArray<{
	profile: "gensec" | "2sec";
	blueprintId: BootstrapBlueprintId;
	role: { category: "staff"; roleId: string; blueprintId: string };
}> = [
	{
		profile: "gensec",
		blueprintId: "gensec",
		role: { category: "staff", roleId: "gensec", blueprintId: "gensec" },
	},
	{
		profile: "2sec",
		blueprintId: "2sec",
		role: { category: "staff", roleId: "2sec", blueprintId: "2sec" },
	},
];

/**
 * Line roles for the Alef→Alef dogfood factory.
 */
export function loadFactoryLineRoles(): FactoryRoleDefinition[] {
	return [
		{
			profile: "coordinator",
			kind: "line",
			codingTools: false,
			role: { category: "line", roleId: "coordinator", blueprintId: "alef-factory-agent" },
			systemPrompt: loadPrompt("coordinator.md"),
		},
		{
			profile: "director",
			kind: "line",
			codingTools: false,
			role: { category: "line", roleId: "director", blueprintId: "alef-factory-agent" },
			systemPrompt: loadPrompt("director.md"),
		},
		{
			profile: "supervisor",
			kind: "line",
			codingTools: false,
			role: { category: "line", roleId: "supervisor", blueprintId: "alef-factory-agent" },
			systemPrompt: loadPrompt("supervisor.md"),
		},
		{
			profile: "worker.coder",
			kind: "worker",
			codingTools: true,
			role: { category: "worker", roleId: "coder", blueprintId: "alef-coding-agent" },
			systemPrompt: loadPrompt("worker-coder.md"),
		},
		{
			profile: "worker.reviewer",
			kind: "worker",
			codingTools: true,
			role: { category: "worker", roleId: "reviewer", blueprintId: "alef-coding-agent" },
			systemPrompt: loadPrompt("worker-reviewer.md"),
		},
		{
			profile: "worker.quality",
			kind: "worker",
			codingTools: true,
			role: { category: "worker", roleId: "quality", blueprintId: "alef-coding-agent" },
			systemPrompt: loadPrompt("worker-quality.md"),
		},
	];
}

/**
 *
 */
export function loadCoordinatorIdentityPrompt(): string {
	return loadPrompt("identity.md");
}
