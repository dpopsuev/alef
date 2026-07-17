import { afterEach, describe, expect, it } from "vitest";
import {
	collectHarnessCard,
	filterDisclosureAdapters,
	formatHarnessCard,
	formatHarnessCardLine,
	harnessCardFingerprint,
	resolveCompactionStrategy,
} from "../src/harness-card.js";

const ENV_KEYS = [
	"ALEF_COMPACTION_STRATEGY",
	"ALEF_TOOL_DISCLOSURE",
	"ALEF_ATTENTION_PIN_RECENT",
	"ALEF_EVAL_MODEL",
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (key in savedEnv) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
			delete savedEnv[key];
		}
	}
});

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
	if (!(key in savedEnv)) savedEnv[key] = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

describe("HarnessCard", { tags: ["unit"] }, () => {
	it("resolveCompactionStrategy defaults to summarize", () => {
		expect(resolveCompactionStrategy(undefined)).toBe("summarize");
		expect(resolveCompactionStrategy("attention")).toBe("attention");
		expect(resolveCompactionStrategy("shake")).toBe("shake");
		expect(resolveCompactionStrategy("off")).toBe("off");
		expect(resolveCompactionStrategy("bogus")).toBe("summarize");
	});

	it("filterDisclosureAdapters drops eval-only hosts and sorts", () => {
		expect(filterDisclosureAdapters(["shell", "evaluator", "fs", "judging", "fs"])).toEqual([
			"fs",
			"shell",
		]);
	});

	it("collectHarnessCard builds fingerprint and reads env", () => {
		setEnv("ALEF_EVAL_MODEL", "test-model");
		setEnv("ALEF_COMPACTION_STRATEGY", "attention");
		setEnv("ALEF_TOOL_DISCLOSURE", "names");
		setEnv("ALEF_ATTENTION_PIN_RECENT", "3");

		const card = collectHarnessCard({
			blueprint: "coding",
			adapters: ["fs", "shell", "evaluator"],
			tools: ["fs.read", "shell.exec"],
			sandbox: true,
		});

		expect(card.schemaVersion).toBe(1);
		expect(card.model).toBe("test-model");
		expect(card.blueprint).toBe("coding");
		expect(card.compactionStrategy).toBe("attention");
		expect(card.toolDisclosure).toBe("names");
		expect(card.attentionPinRecentTurns).toBe(3);
		expect(card.adapters).toEqual(["fs", "shell"]);
		expect(card.tools).toEqual(["fs.read", "shell.exec"]);
		expect(card.sandbox).toBe(true);
		expect(card.execution.sandbox).toBe(true);
		expect(card.governance.lifecycleIntercepts.length).toBeGreaterThan(0);
		expect(card.fingerprint).toHaveLength(16);
		expect(card.collectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

		const expected = harnessCardFingerprint({
			schemaVersion: 1,
			model: card.model,
			provider: card.provider,
			contextWindow: card.contextWindow,
			blueprint: card.blueprint,
			adapters: card.adapters,
			tools: card.tools,
			compactionStrategy: card.compactionStrategy,
			toolDisclosure: card.toolDisclosure,
			attentionPinRecentTurns: card.attentionPinRecentTurns,
			writableRoots: card.writableRoots,
			sandbox: card.sandbox,
			scenarioTimeoutMs: card.scenarioTimeoutMs,
			noiseSeeding: card.noiseSeeding,
			execution: card.execution,
			governance: card.governance,
		});
		expect(card.fingerprint).toBe(expected);
	});

	it("fingerprint is stable across collectedAt", () => {
		const a = collectHarnessCard({ model: "m", adapters: ["fs"], tools: ["t"] });
		const b = collectHarnessCard({ model: "m", adapters: ["fs"], tools: ["t"] });
		expect(a.fingerprint).toBe(b.fingerprint);
		expect(a.fingerprint).toBe(
			harnessCardFingerprint({
				schemaVersion: 1,
				model: "m",
				adapters: ["fs"],
				tools: ["t"],
				compactionStrategy: a.compactionStrategy,
				toolDisclosure: a.toolDisclosure,
				execution: a.execution,
				governance: a.governance,
			}),
		);
	});

	it("defaults sandbox on with execution and governance disclosure", () => {
		const card = collectHarnessCard({
			model: "m",
			writableRoots: ["/tmp/ws"],
			scenarioTimeoutMs: 60_000,
		});
		expect(card.execution.sandbox).toBe(true);
		expect(card.execution.writableRoots).toEqual(["/tmp/ws"]);
		expect(card.execution.networkPolicy).toBe("workspace");
		expect(card.execution.scenarioTimeoutMs).toBe(60_000);
		expect(card.governance.approvalMode).toBe("none");
		expect(card.governance.lifecycleIntercepts).toContain("binding.chain");
	});

	it("overrides win for disclosure fields", () => {
		const card = collectHarnessCard({
			model: "base",
			adapters: ["fs"],
			overrides: { model: "override", adapters: ["shell", "evaluator"] },
		});
		expect(card.model).toBe("override");
		expect(card.adapters).toEqual(["shell"]);
	});

	it("formatters include fingerprint and key knobs", () => {
		const card = collectHarnessCard({
			model: "m1",
			blueprint: "coding",
			adapters: ["fs"],
			tools: ["fs.read"],
			compactionStrategy: "attention",
			toolDisclosure: "full",
		});
		const line = formatHarnessCardLine(card);
		expect(line).toContain(`fp=${card.fingerprint}`);
		expect(line).toContain("model=m1");
		expect(line).toContain("blueprint=coding");
		expect(line).toContain("compaction=attention");

		const multi = formatHarnessCard(card);
		expect(multi).toContain(`fingerprint=${card.fingerprint}`);
		expect(multi).toContain("adapters: fs");
		expect(multi).toContain("tools: fs.read");
		expect(multi).toContain("execution:");
		expect(multi).toContain("governance:");
		expect(line).toContain("sandbox=");
	});
});
