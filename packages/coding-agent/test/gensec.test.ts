/**
 * Tests for the General Secretary — agent factory factory and lifecycle manager.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryBoard } from "../src/board/board.js";
import { GENSEC_COLOR } from "../src/board/color-registry.js";
import { type AgentSchema, GeneralSecretary } from "../src/board/gensec.js";

const SCOUT_SCHEMA: AgentSchema = {
	name: "scout",
	role: "scout",
	systemPrompt: "You analyze codebases and report findings.",
	tools: ["file_read", "file_bash", "symbol_outline"],
	colorPreference: { shade: "green" },
};

const WORKER_SCHEMA: AgentSchema = {
	name: "worker",
	role: "worker",
	systemPrompt: "You implement changes.",
	tools: ["file_read", "file_bash", "file_edit", "file_write"],
	colorPreference: { shade: "blue" },
	canSpawn: ["reviewer"], // workers can spawn reviewers
};

const REVIEWER_SCHEMA: AgentSchema = {
	name: "reviewer",
	role: "reviewer",
	systemPrompt: "You review code changes.",
	tools: ["file_read", "symbol_outline"],
	colorPreference: { shade: "red" },
};

describe("GeneralSecretary", () => {
	let board: InMemoryBoard;
	let gensec: GeneralSecretary;

	beforeEach(() => {
		board = new InMemoryBoard();
		gensec = new GeneralSecretary(board);
		gensec.registerSchema(SCOUT_SCHEMA);
		gensec.registerSchema(WORKER_SCHEMA);
		gensec.registerSchema(REVIEWER_SCHEMA);
	});

	// =====================================================================
	// Identity
	// =====================================================================

	it("GenSec has the onyx color identity", () => {
		expect(gensec.color).toEqual(GENSEC_COLOR);
		expect(gensec.color.name).toBe("onyx");
		expect(gensec.id).toBe("gensec");
	});

	// =====================================================================
	// Schema management
	// =====================================================================

	it("registers and retrieves schemas", () => {
		expect(gensec.getSchema("scout")).toEqual(SCOUT_SCHEMA);
		expect(gensec.getSchema("worker")).toEqual(WORKER_SCHEMA);
		expect(gensec.getSchema("nonexistent")).toBeUndefined();
	});

	it("lists all schemas", () => {
		expect(gensec.getSchemas()).toHaveLength(3);
	});

	// =====================================================================
	// Agent creation — factory factory
	// =====================================================================

	it("creates an agent from a schema", () => {
		const agent = gensec.createAgent("scout", "refactor", { read: ["*"], write: ["forum.refactor.*"] });
		expect(agent.schemaName).toBe("scout");
		expect(agent.color.role).toBe("scout");
		expect(agent.spawnedBy).toBe("gensec");
		expect(agent.status).toBe("idle");
	});

	it("assigns colors from preferred shade", () => {
		const agent = gensec.createAgent("scout", "proj", { read: ["*"], write: ["*"] });
		// Scout prefers green shade
		expect(agent.color.family).toBe("green");
	});

	it("each agent gets a unique color", () => {
		const a1 = gensec.createAgent("scout", "proj", { read: ["*"], write: ["*"] });
		const a2 = gensec.createAgent("scout", "proj", { read: ["*"], write: ["*"] });
		expect(a1.color.name).not.toBe(a2.color.name);
	});

	it("rejects unknown schema", () => {
		expect(() => gensec.createAgent("hacker", "proj", { read: ["*"], write: ["*"] })).toThrow("Unknown agent schema");
	});

	// =====================================================================
	// Permission-checked spawning
	// =====================================================================

	it("worker can spawn reviewer (permitted)", () => {
		const worker = gensec.createAgent("worker", "proj", { read: ["*"], write: ["*"] });
		const reviewer = gensec.requestSpawn(worker.id, "reviewer", "proj", { read: ["*"], write: ["*"] });
		expect(reviewer.schemaName).toBe("reviewer");
		expect(reviewer.spawnedBy).toBe(worker.id);
	});

	it("reviewer cannot spawn worker (not permitted)", () => {
		const reviewer = gensec.createAgent("reviewer", "proj", { read: ["*"], write: ["*"] });
		expect(() => gensec.requestSpawn(reviewer.id, "worker", "proj", { read: ["*"], write: ["*"] })).toThrow(
			"not permitted to spawn",
		);
	});

	it("scout cannot spawn anything (no canSpawn)", () => {
		const scout = gensec.createAgent("scout", "proj", { read: ["*"], write: ["*"] });
		expect(() => gensec.requestSpawn(scout.id, "worker", "proj", { read: ["*"], write: ["*"] })).toThrow(
			"not permitted to spawn",
		);
	});

	it("rejects spawn from unknown agent", () => {
		expect(() => gensec.requestSpawn("fake-id", "scout", "proj", { read: ["*"], write: ["*"] })).toThrow(
			"Unknown requesting agent",
		);
	});

	// =====================================================================
	// Agent lifecycle
	// =====================================================================

	it("stops an agent and releases its color", () => {
		const agent = gensec.createAgent("scout", "proj", { read: ["*"], write: ["*"] });
		gensec.stopAgent(agent.id);
		expect(agent.status).toBe("stopped");

		// Color is released — can be reused
		const agent2 = gensec.createAgent("scout", "proj2", { read: ["*"], write: ["*"] });
		// The same color might be assigned again (not guaranteed, but possible)
		expect(agent2.status).toBe("idle");
	});

	it("getActiveAgents excludes stopped agents", () => {
		const a1 = gensec.createAgent("scout", "proj", { read: ["*"], write: ["*"] });
		const a2 = gensec.createAgent("worker", "proj", { read: ["*"], write: ["*"] });
		gensec.stopAgent(a1.id);

		const active = gensec.getActiveAgents();
		expect(active).toHaveLength(1);
		expect(active[0].id).toBe(a2.id);
	});

	it("getAgentByColor finds by color name", () => {
		const agent = gensec.createAgent("scout", "proj", { read: ["*"], write: ["*"] });
		expect(gensec.getAgentByColor(agent.color.name)?.id).toBe(agent.id);
		expect(gensec.getAgentByColor("nonexistent")).toBeUndefined();
	});

	// =====================================================================
	// Contract management
	// =====================================================================

	it("creates a contract with forum and topics", () => {
		const contract = gensec.createContract("Refactor auth", [
			{ id: "s1", name: "Analyze", agentRole: "scout", agentCount: 1, execution: "serial", dependsOn: [] },
			{ id: "s2", name: "Implement", agentRole: "worker", agentCount: 2, execution: "parallel", dependsOn: ["s1"] },
		]);

		expect(contract.goal).toBe("Refactor auth");
		expect(contract.status).toBe("active");
		expect(contract.stages).toHaveLength(2);

		// Forum and topics created on the board
		expect(board.getForums()).toHaveLength(1);
		expect(board.getTopics(contract.forumId)).toHaveLength(2);
	});

	it("updates contract status", () => {
		const contract = gensec.createContract("Goal", [
			{ id: "s1", name: "Do", agentRole: "worker", agentCount: 1, execution: "serial", dependsOn: [] },
		]);

		gensec.updateContractStatus(contract.id, "completed");
		expect(board.getContract(contract.id)?.status).toBe("completed");
	});

	it("rejects status update for unknown contract", () => {
		expect(() => gensec.updateContractStatus("fake", "failed")).toThrow("Contract not found");
	});

	// =====================================================================
	// Message routing
	// =====================================================================

	it("routes @colorname to the right agent", () => {
		const agent = gensec.createAgent("scout", "proj", { read: ["*"], write: ["*"] });
		const result = gensec.routeMessage(`@${agent.color.name} analyze the auth module`);
		expect(result.target).toBe("agent");
		if (result.target === "agent") {
			expect(result.agentId).toBe(agent.id);
			expect(result.text).toBe("analyze the auth module");
		}
	});

	it("routes unaddressed messages to GenSec", () => {
		const result = gensec.routeMessage("refactor the auth module");
		expect(result.target).toBe("gensec");
		expect(result.text).toBe("refactor the auth module");
	});

	it("routes @unknown to GenSec (fallback)", () => {
		const result = gensec.routeMessage("@ghost do something");
		expect(result.target).toBe("gensec");
	});

	it("does not route to stopped agents", () => {
		const agent = gensec.createAgent("scout", "proj", { read: ["*"], write: ["*"] });
		gensec.stopAgent(agent.id);
		const result = gensec.routeMessage(`@${agent.color.name} still here?`);
		expect(result.target).toBe("gensec");
	});

	it("case-insensitive @routing", () => {
		const agent = gensec.createAgent("scout", "proj", { read: ["*"], write: ["*"] });
		const upper = agent.color.name.charAt(0).toUpperCase() + agent.color.name.slice(1);
		const result = gensec.routeMessage(`@${upper} do something`);
		expect(result.target).toBe("agent");
	});
});
