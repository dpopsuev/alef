/**
 * General Secretary — the root agent and agent factory factory.
 *
 * KISS design principles (gradually evolved):
 *   - GenSec is the ONLY agent with Supervisor/Broker API access
 *   - GenSec never executes tools directly — it plans and delegates
 *   - GenSec defines Agent Schemas (blueprints) that other agents
 *     can instantiate IF their permission schema allows it
 *   - The Board is the shared state; GenSec owns it
 *
 * Influence:
 *   - Djinn: Terminal (single entry), Vezir (stateless supervisor),
 *     Discourse (planning) vs Assignment (execution)
 *   - Tako: Factory pattern, Organ contract (Name + Receive),
 *     stigmergic coordination via shared state
 *   - Tangle: Color identity, Broker/Actor/Director
 *   - Hegemony/Demiurge: SharedState in-memory, triple-homed bridge
 *
 * Evolution path:
 *   v0: GenSec is the only agent. Plans and executes (current Alef).
 *   v1: GenSec can spawn workers via the Broker. Workers execute.
 *   v2: GenSec defines Agent Schemas. Workers can spawn sub-workers
 *       within their permission scope.
 *   v3: Semantic routing. @agent addressing. Discourse threads.
 */

import { randomUUID } from "node:crypto";
import type { Board } from "./board.js";
import { type AgentColor, ColorRegistry, GENSEC_COLOR } from "./color-registry.js";
import type { Contract, ContractStage, ContractStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Agent Schema — blueprint for creating agents
// ---------------------------------------------------------------------------

/**
 * An Agent Schema is a reusable blueprint.
 * GenSec registers schemas. Agents with permission can instantiate them.
 */
export interface AgentSchema {
	/** Unique schema name (e.g., "scout", "worker", "reviewer") */
	name: string;
	/** Role description for the agent */
	role: string;
	/** System prompt for the agent */
	systemPrompt: string;
	/** Tools the agent is allowed to use */
	tools?: string[];
	/** Model override */
	model?: string;
	/** Color preference */
	colorPreference?: { shade?: string; color?: string };
	/** Whether this agent can spawn sub-agents (and which schemas) */
	canSpawn?: string[];
}

// ---------------------------------------------------------------------------
// Agent Instance — a running agent created from a schema
// ---------------------------------------------------------------------------

export interface AgentInstance {
	id: string;
	schemaName: string;
	color: AgentColor;
	/** Board scope: which forums/topics/threads this agent can access */
	scope: { read: string[]; write: string[] };
	/** Who spawned this agent (GenSec ID or another agent ID) */
	spawnedBy: string;
	status: "idle" | "running" | "stopped";
}

// ---------------------------------------------------------------------------
// General Secretary
// ---------------------------------------------------------------------------

export class GeneralSecretary {
	readonly color: AgentColor = GENSEC_COLOR;
	readonly id = "gensec";

	private schemas = new Map<string, AgentSchema>();
	private agents = new Map<string, AgentInstance>();
	private colorRegistry = new ColorRegistry();

	constructor(private board: Board) {
		// Reserve GenSec's color
		this.colorRegistry.set("black", "onyx", "secretary", "system");
	}

	// =====================================================================
	// Schema management — GenSec is the only registrar
	// =====================================================================

	/** Register an agent schema (blueprint) */
	registerSchema(schema: AgentSchema): void {
		this.schemas.set(schema.name, schema);
	}

	/** Get a registered schema */
	getSchema(name: string): AgentSchema | undefined {
		return this.schemas.get(name);
	}

	/** List all registered schemas */
	getSchemas(): AgentSchema[] {
		return [...this.schemas.values()];
	}

	// =====================================================================
	// Agent lifecycle — factory factory
	// =====================================================================

	/**
	 * Create an agent instance from a schema.
	 * Only GenSec can call this directly. Other agents must go through
	 * their permission-checked spawn path.
	 */
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

		// Assign color identity
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

	/**
	 * Spawn request from a non-GenSec agent.
	 * Checks if the requesting agent has permission to spawn the schema.
	 */
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

		// Permission check: can this agent spawn this schema?
		if (!requesterSchema.canSpawn?.includes(schemaName)) {
			throw new Error(
				`Agent "${requester.color.name}" (${requester.schemaName}) is not permitted to spawn "${schemaName}"`,
			);
		}

		return this.createAgent(schemaName, collective, scope, requestingAgentId);
	}

	/** Stop an agent and release its color */
	stopAgent(agentId: string): void {
		const agent = this.agents.get(agentId);
		if (!agent) return;
		agent.status = "stopped";
		this.colorRegistry.release(agent.color);
	}

	/** Get an agent by ID */
	getAgent(id: string): AgentInstance | undefined {
		return this.agents.get(id);
	}

	/** Get an agent by color name */
	getAgentByColor(colorName: string): AgentInstance | undefined {
		for (const agent of this.agents.values()) {
			if (agent.color.name === colorName) return agent;
		}
		return undefined;
	}

	/** List all active agents */
	getActiveAgents(): AgentInstance[] {
		return [...this.agents.values()].filter((a) => a.status !== "stopped");
	}

	// =====================================================================
	// Contract management
	// =====================================================================

	/**
	 * Create a contract — the execution plan.
	 * Sets up the forum and topics on the Board.
	 */
	createContract(goal: string, stages: ContractStage[]): Contract {
		const forum = this.board.createForum(goal);

		// Create topics for each stage
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

	/** Update contract status */
	updateContractStatus(contractId: string, status: ContractStatus): void {
		const contract = this.board.getContract(contractId);
		if (!contract) throw new Error(`Contract not found: "${contractId}"`);
		contract.status = status;
		this.board.setContract(contract);
	}

	// =====================================================================
	// Message routing
	// =====================================================================

	/**
	 * Route a message to the right agent.
	 * - @colorname → direct route to that agent
	 * - Unaddressed → GenSec handles it (plans, delegates, or responds)
	 */
	routeMessage(text: string): { target: "gensec"; text: string } | { target: "agent"; agentId: string; text: string } {
		const atMatch = text.match(/^@(\w+)\s+(.*)/s);
		if (atMatch) {
			const colorName = atMatch[1].toLowerCase();
			const agent = this.getAgentByColor(colorName);
			if (agent && agent.status !== "stopped") {
				return { target: "agent", agentId: agent.id, text: atMatch[2] };
			}
			// Unknown agent — fall through to GenSec
		}
		return { target: "gensec", text };
	}
}
