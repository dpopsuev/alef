import { randomUUID } from "node:crypto";
import type { Board } from "./board.js";
import { type AgentColor, ColorRegistry, GENSEC_COLOR } from "./color-registry.js";
import type { Contract, ContractStage, ContractStatus } from "./types.js";

export interface AgentSchema {
	name: string;
	role: string;
	systemPrompt: string;
	tools?: string[];
	model?: string;
	colorPreference?: { shade?: string; color?: string };
	canSpawn?: string[];
}

export interface AgentInstance {
	id: string;
	schemaName: string;
	color: AgentColor;
	scope: { read: string[]; write: string[] };
	spawnedBy: string;
	status: "idle" | "running" | "stopped";
}

export class GeneralSecretary {
	readonly color: AgentColor = GENSEC_COLOR;
	readonly id = "gensec";

	private schemas = new Map<string, AgentSchema>();
	private agents = new Map<string, AgentInstance>();
	private colorRegistry = new ColorRegistry();

	constructor(private board: Board) {
		this.colorRegistry.set("black", "onyx", "secretary", "system");
	}

	registerSchema(schema: AgentSchema): void {
		this.schemas.set(schema.name, schema);
	}

	getSchema(name: string): AgentSchema | undefined {
		return this.schemas.get(name);
	}

	getSchemas(): AgentSchema[] {
		return [...this.schemas.values()];
	}

	createAgent(
		schemaName: string,
		collective: string,
		scope: { read: string[]; write: string[] },
		spawnedBy = this.id,
	): AgentInstance {
		const schema = this.schemas.get(schemaName);
		if (!schema) {
			throw new Error(`Unknown agent schema: "${schemaName}"`);
		}

		const color = schema.colorPreference
			? this.colorRegistry.assignWithPreference(schema.colorPreference, schema.role, collective)
			: this.colorRegistry.assign(schema.role, collective);

		const agent: AgentInstance = {
			id: randomUUID(),
			schemaName,
			color,
			scope,
			spawnedBy,
			status: "idle",
		};

		this.agents.set(agent.id, agent);
		return agent;
	}

	requestSpawn(
		requestingAgentId: string,
		schemaName: string,
		collective: string,
		scope: { read: string[]; write: string[] },
	): AgentInstance {
		const requester = this.agents.get(requestingAgentId);
		if (!requester) {
			throw new Error(`Unknown requesting agent: "${requestingAgentId}"`);
		}

		const requesterSchema = this.schemas.get(requester.schemaName);
		if (!requesterSchema) {
			throw new Error(`No schema for requesting agent: "${requester.schemaName}"`);
		}

		if (!requesterSchema.canSpawn?.includes(schemaName)) {
			throw new Error(
				`Agent "${requester.color.name}" (${requester.schemaName}) is not permitted to spawn "${schemaName}"`,
			);
		}

		return this.createAgent(schemaName, collective, scope, requestingAgentId);
	}

	stopAgent(agentId: string): void {
		const agent = this.agents.get(agentId);
		if (!agent) return;
		agent.status = "stopped";
		this.colorRegistry.release(agent.color);
	}

	getAgent(id: string): AgentInstance | undefined {
		return this.agents.get(id);
	}

	getAgentByColor(colorName: string): AgentInstance | undefined {
		for (const agent of this.agents.values()) {
			if (agent.color.name === colorName) return agent;
		}
		return undefined;
	}

	getActiveAgents(): AgentInstance[] {
		return [...this.agents.values()].filter((a) => a.status !== "stopped");
	}

	createContract(goal: string, stages: ContractStage[]): Contract {
		const forum = this.board.createForum(goal);

		for (const stage of stages) {
			const topic = this.board.createTopic(forum.id, stage.name, stage.id);
			stage.topicId = topic.id;
		}

		const contract: Contract = {
			id: randomUUID(),
			goal,
			forumId: forum.id,
			stages,
			breakpoints: [],
			status: "active",
			createdAt: Date.now(),
		};

		this.board.setContract(contract);
		return contract;
	}

	updateContractStatus(contractId: string, status: ContractStatus): void {
		const contract = this.board.getContract(contractId);
		if (!contract) throw new Error(`Contract not found: "${contractId}"`);
		contract.status = status;
		this.board.setContract(contract);
	}

	routeMessage(text: string): { target: "gensec"; text: string } | { target: "agent"; agentId: string; text: string } {
		const atMatch = text.match(/^@(\w+)\s+(.*)/s);
		if (atMatch) {
			const colorName = atMatch[1].toLowerCase();
			const agent = this.getAgentByColor(colorName);
			if (agent && agent.status !== "stopped") {
				return { target: "agent", agentId: agent.id, text: atMatch[2] };
			}
		}
		return { target: "gensec", text };
	}
}
