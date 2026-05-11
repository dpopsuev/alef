/**
 * Tests for the Agent Catalog Registry — searchable agent schema arsenal.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { AgentCatalog } from "../src/board/catalog.js";
import type { AgentSchema } from "../src/board/gensec.js";

const SCOUT: AgentSchema = { name: "scout", role: "scout", systemPrompt: "Analyze code." };
const WORKER: AgentSchema = {
	name: "worker",
	role: "worker",
	systemPrompt: "Implement changes.",
	tools: ["file_edit"],
};
const REVIEWER: AgentSchema = { name: "reviewer", role: "reviewer", systemPrompt: "Review code." };
const RESEARCHER: AgentSchema = {
	name: "researcher",
	role: "researcher",
	systemPrompt: "Search the web.",
	tools: ["web_search"],
};

describe("AgentCatalog", () => {
	let catalog: AgentCatalog;

	beforeEach(() => {
		catalog = new AgentCatalog();
		catalog.register(SCOUT, {
			description: "Fast codebase reconnaissance",
			labels: ["analysis", "read-only"],
			capabilities: ["code_analysis", "file_reading"],
		});
		catalog.register(WORKER, {
			description: "Implementation and code modification",
			labels: ["implementation", "write"],
			capabilities: ["code_edit", "file_writing", "refactoring"],
		});
		catalog.register(REVIEWER, {
			description: "Code review and quality assessment",
			labels: ["review", "read-only", "quality"],
			capabilities: ["code_review", "testing"],
		});
		catalog.register(RESEARCHER, {
			description: "Web research and documentation lookup",
			labels: ["research", "external"],
			capabilities: ["web_search", "documentation"],
		});
	});

	// =====================================================================
	// Registration
	// =====================================================================

	it("registers schemas and reports size", () => {
		expect(catalog.size).toBe(4);
	});

	it("get by name returns the schema", () => {
		const result = catalog.get("scout");
		expect(result).toBeTruthy();
		expect(result!.schema.name).toBe("scout");
		expect(result!.description).toBe("Fast codebase reconnaissance");
		expect(result!.labels).toContain("analysis");
		expect(result!.capabilities).toContain("code_analysis");
	});

	it("get unknown returns undefined", () => {
		expect(catalog.get("hacker")).toBeUndefined();
	});

	it("re-registration updates in place", () => {
		catalog.register(SCOUT, {
			description: "Updated scout description",
			labels: ["analysis", "updated"],
			capabilities: ["code_analysis"],
			version: "2.0.0",
		});
		expect(catalog.size).toBe(4); // no duplicate
		const result = catalog.get("scout");
		expect(result!.description).toBe("Updated scout description");
		expect(result!.version).toBe("2.0.0");
		expect(result!.labels).toContain("updated");
	});

	it("unregister removes schema", () => {
		catalog.unregister("scout");
		expect(catalog.get("scout")).toBeUndefined();
		expect(catalog.size).toBe(3);
	});

	// =====================================================================
	// List
	// =====================================================================

	it("list returns all schemas sorted by name", () => {
		const all = catalog.list();
		expect(all).toHaveLength(4);
		expect(all.map((r) => r.schema.name)).toEqual(["researcher", "reviewer", "scout", "worker"]);
	});

	// =====================================================================
	// Search — by role
	// =====================================================================

	it("search by role", () => {
		const results = catalog.search({ role: "scout" });
		expect(results).toHaveLength(1);
		expect(results[0].schema.name).toBe("scout");
	});

	it("search by unknown role returns empty", () => {
		expect(catalog.search({ role: "hacker" })).toHaveLength(0);
	});

	// =====================================================================
	// Search — by labels
	// =====================================================================

	it("search by single label", () => {
		const results = catalog.search({ labels: ["read-only"] });
		expect(results).toHaveLength(2); // scout + reviewer
		expect(results.map((r) => r.schema.name).sort()).toEqual(["reviewer", "scout"]);
	});

	it("search by multiple labels (all must match)", () => {
		const results = catalog.search({ labels: ["read-only", "quality"] });
		expect(results).toHaveLength(1);
		expect(results[0].schema.name).toBe("reviewer");
	});

	it("search by labels with no match", () => {
		expect(catalog.search({ labels: ["nonexistent"] })).toHaveLength(0);
	});

	// =====================================================================
	// Search — by capabilities
	// =====================================================================

	it("search by capability (any match)", () => {
		const results = catalog.search({ capabilities: ["web_search"] });
		expect(results).toHaveLength(1);
		expect(results[0].schema.name).toBe("researcher");
	});

	it("search by multiple capabilities (any match)", () => {
		const results = catalog.search({ capabilities: ["code_review", "web_search"] });
		expect(results).toHaveLength(2); // reviewer + researcher
	});

	// =====================================================================
	// Search — free text
	// =====================================================================

	it("search by text matches name", () => {
		const results = catalog.search({ text: "scout" });
		expect(results).toHaveLength(1);
		expect(results[0].score).toBe(1.0); // exact name match
	});

	it("search by text matches description", () => {
		const results = catalog.search({ text: "reconnaissance" });
		expect(results).toHaveLength(1);
		expect(results[0].schema.name).toBe("scout");
		expect(results[0].score).toBe(0.7); // description match
	});

	it("search by text matches label", () => {
		const results = catalog.search({ text: "external" });
		expect(results).toHaveLength(1);
		expect(results[0].schema.name).toBe("researcher");
	});

	it("text search is case insensitive", () => {
		expect(catalog.search({ text: "SCOUT" })).toHaveLength(1);
		expect(catalog.search({ text: "Code Review" })).toHaveLength(1);
	});

	it("text search with no match returns empty", () => {
		expect(catalog.search({ text: "quantum computing" })).toHaveLength(0);
	});

	// =====================================================================
	// Search — combined filters
	// =====================================================================

	it("combined role + labels", () => {
		const results = catalog.search({ role: "reviewer", labels: ["quality"] });
		expect(results).toHaveLength(1);
		expect(results[0].schema.name).toBe("reviewer");
	});

	it("combined filters that exclude everything", () => {
		const results = catalog.search({ role: "scout", labels: ["write"] });
		expect(results).toHaveLength(0);
	});

	it("text + capability filter", () => {
		const results = catalog.search({ text: "code", capabilities: ["code_edit"] });
		expect(results).toHaveLength(1);
		expect(results[0].schema.name).toBe("worker");
	});

	// =====================================================================
	// Results are scored and sorted by relevance
	// =====================================================================

	it("exact name match scores higher than description match", () => {
		// "worker" appears in name for worker, but also might appear in descriptions
		const results = catalog.search({ text: "worker" });
		expect(results[0].schema.name).toBe("worker");
		expect(results[0].score).toBe(1.0);
	});

	// =====================================================================
	// ECS World access
	// =====================================================================

	it("getWorld exposes the underlying ECS", () => {
		const world = catalog.getWorld();
		expect(world.count()).toBe(4);
	});
});
