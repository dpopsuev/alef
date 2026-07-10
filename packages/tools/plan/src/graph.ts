import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const MAX_LABEL_WORDS = 12;
const MIN_LABEL_WORDS = 3;
const MAX_SLUG_LENGTH = 60;

/** Deterministic assertion gate for a plan step. */
export interface Gate {
	type: "file-exists" | "command" | "contains" | "test";
	target: string;
	expect?: string;
}

/** Outcome of running a single gate assertion. */
export interface GateResult {
	gate: Gate;
	passed: boolean;
	output: string;
}

/** LLM inspector assigned to evaluate a step on completion. */
export interface Inspector {
	type: string;
	prompt: string;
}

/** Lifecycle status of a plan step. */
export type StepStatus = "pending" | "active" | "done" | "failed" | "dropped";

/** A single step in the plan graph with gates and optional inspector. */
export interface Step {
	id: string;
	label: string;
	parent: string | null;
	status: StepStatus;
	depth: number;
	gates: Gate[];
	inspector?: Inspector;
	result?: string;
	gateResults?: GateResult[];
	startedAt?: number;
	completedAt?: number;
}

/** High-level phase of the plan lifecycle. */
export type PlanPhase = "open" | "working" | "closed";

/** Serializable snapshot of the entire plan state. */
export interface PlanData {
	id: string;
	phase: PlanPhase;
	current: string;
	desired: string;
	verify: string;
	steps: Step[];
	summary?: string;
	createdAt: number;
	updatedAt: number;
}

/** Directed step graph with gate-guarded transitions and disk persistence. */
export class PlanGraph {
	private data: PlanData;
	private diskPath: string | null;
	private stepIndex = new Map<string, Step>();
	private childIndex = new Map<string, string[]>();
	private seq = 0;

	constructor(id: string, current: string, desired: string, verify: string, diskPath: string | null = null) {
		this.data = {
			id,
			phase: "open",
			current,
			desired,
			verify,
			steps: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.diskPath = diskPath;
		this.flush();
	}

	static load(diskPath: string): PlanGraph | null {
		try {
			const raw = readFileSync(diskPath, "utf-8");
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- plan JSON written by flush()
			const data = JSON.parse(raw) as PlanData;
			const graph = new PlanGraph(data.id, data.current, data.desired, data.verify, diskPath);
			graph.data = data;
			graph.rebuildIndex();
			return graph;
		} catch {
			return null;
		}
	}

	private rebuildIndex(): void {
		this.stepIndex.clear();
		this.childIndex.clear();
		for (const step of this.data.steps) {
			this.stepIndex.set(step.id, step);
			const parentKey = step.parent ?? "__root__";
			const children = this.childIndex.get(parentKey) ?? [];
			children.push(step.id);
			this.childIndex.set(parentKey, children);
		}
		this.seq = this.data.steps.length;
	}

	private touch(): void {
		this.data.updatedAt = Date.now();
		this.flush();
	}

	private flush(): void {
		if (!this.diskPath) return;
		writeFileSync(this.diskPath, JSON.stringify(this.data, null, 2), "utf-8");
	}

	get id(): string {
		return this.data.id;
	}
	get phase(): PlanPhase {
		return this.data.phase;
	}
	get current(): string {
		return this.data.current;
	}
	get desired(): string {
		return this.data.desired;
	}
	get verify(): string {
		return this.data.verify;
	}

	private slugify(label: string): string {
		let slug = label
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.trim()
			.replace(/\s+/g, "-")
			.slice(0, MAX_SLUG_LENGTH);
		if (this.stepIndex.has(slug)) {
			slug = `${slug}-${this.seq}`;
		}
		return slug;
	}

	addStep(label: string, parent: string | null, gates: Gate[] = [], inspector?: Inspector): Step {
		const words = label.trim().split(/\s+/);
		if (words.length < MIN_LABEL_WORDS) throw new Error(`Step label too short (${words.length} words, min ${MIN_LABEL_WORDS}): "${label}"`);
		if (words.length > MAX_LABEL_WORDS) throw new Error(`Step label too long (${words.length} words, max ${MAX_LABEL_WORDS}): "${label}"`);
		if (parent && !this.stepIndex.has(parent)) throw new Error(`parent step ${parent} not found`);

		const id = this.slugify(label);
		const depth = parent ? (this.stepIndex.get(parent)?.depth ?? 0) + 1 : 0;
		const step: Step = { id, label, parent, status: "pending", depth, gates };
		if (inspector) step.inspector = inspector;

		this.data.steps.push(step);
		this.stepIndex.set(id, step);
		this.seq++;

		const parentKey = parent ?? "__root__";
		const children = this.childIndex.get(parentKey) ?? [];
		children.push(id);
		this.childIndex.set(parentKey, children);

		this.touch();
		return step;
	}

	startStep(id: string): Step | null {
		const step = this.stepIndex.get(id);
		if (!step || (step.status !== "pending" && step.status !== "failed")) return null;
		step.status = "active";
		step.startedAt = Date.now();
		if (this.data.phase === "open") this.data.phase = "working";
		this.touch();
		return step;
	}

	completeStep(id: string, result?: string): { step: Step; gateResults: GateResult[] } | null {
		const step = this.stepIndex.get(id);
		if (!step || step.status !== "active") return null;

		const gateResults = this.runGates(step.gates);
		step.gateResults = gateResults;
		if (result) step.result = result;

		const allPassed = gateResults.every((g) => g.passed);
		if (allPassed) {
			step.status = "done";
			step.completedAt = Date.now();
		} else {
			step.status = "failed";
			step.result = gateResults
				.filter((g) => !g.passed)
				.map((g) => `gate failed: ${g.gate.type} ${g.gate.target} — ${g.output}`)
				.join("; ");
		}
		this.touch();
		return { step, gateResults };
	}

	failStep(id: string, reason: string): Step | null {
		const step = this.stepIndex.get(id);
		if (!step || step.status !== "active") return null;
		step.status = "failed";
		step.result = reason;
		this.touch();
		return step;
	}

	dropStep(id: string): Step | null {
		const step = this.stepIndex.get(id);
		if (!step || step.status === "done" || step.status === "dropped") return null;
		step.status = "dropped";
		this.touch();
		return step;
	}

	amend(updates: { current?: string; desired?: string; verify?: string }): void {
		if (updates.current) this.data.current = updates.current;
		if (updates.desired) this.data.desired = updates.desired;
		if (updates.verify) this.data.verify = updates.verify;
		this.touch();
	}

	close(summary: string): void {
		this.data.summary = summary;
		this.data.phase = "closed";
		this.touch();
	}

	getStep(id: string): Step | undefined {
		return this.stepIndex.get(id);
	}

	children(parentId: string | null): Step[] {
		const key = parentId ?? "__root__";
		return (this.childIndex.get(key) ?? [])
			.map((id) => this.stepIndex.get(id))
			.filter((s): s is Step => s !== undefined);
	}

	nextReady(): Step | null {
		for (const step of this.data.steps) {
			if (step.status !== "pending") continue;
			if (!step.parent) return step;
			const parentStep = this.stepIndex.get(step.parent);
			if (parentStep && (parentStep.status === "active" || parentStep.status === "done")) return step;
		}
		return null;
	}

	stats(): { total: number; done: number; pending: number; active: number; failed: number; dropped: number } {
		let done = 0;
		let pending = 0;
		let active = 0;
		let failed = 0;
		let dropped = 0;
		for (const s of this.data.steps) {
			if (s.status === "done") done++;
			else if (s.status === "pending") pending++;
			else if (s.status === "active") active++;
			else if (s.status === "failed") failed++;
			else dropped++;
		}
		return { total: this.data.steps.length, done, pending, active, failed, dropped };
	}

	private static glyph(status: StepStatus): string {
		switch (status) {
			case "done":
				return "■";
			case "active":
				return "●";
			case "failed":
				return "✗";
			case "dropped":
				return "×";
			default:
				return "○";
		}
	}

	renderTree(): string {
		const lines: string[] = [];
		const render = (step: Step, prefix: string, isLast: boolean): void => {
			const branch = isLast ? "└── " : "├── ";
			const active = step.status === "active" ? "  ◄" : "";
			lines.push(`${prefix}${branch}${PlanGraph.glyph(step.status)} ${step.id}${active}`);
			if (step.status === "active") {
				for (const g of step.gates) {
					const gateStr = g.expect ? `${g.type}: ${g.target} = ${g.expect}` : `${g.type}: ${g.target}`;
					lines.push(`${prefix}${isLast ? "    " : "│   "}   gate: [${gateStr}]`);
				}
				if (step.inspector) {
					lines.push(`${prefix}${isLast ? "    " : "│   "}   inspector: [${step.inspector.type}: ${step.inspector.prompt.slice(0, 60)}]`);
				}
			}
			const kids = this.children(step.id);
			for (let i = 0; i < kids.length; i++) {
				render(kids[i]!, `${prefix}${isLast ? "    " : "│   "}`, i === kids.length - 1);
			}
		};
		const roots = this.children(null);
		for (let i = 0; i < roots.length; i++) {
			render(roots[i]!, "", i === roots.length - 1);
		}
		return lines.join("\n");
	}

	renderSummary(): string {
		const s = this.stats();
		const parts = [
			`[Plan — ${this.data.phase}]`,
			`Current: ${this.data.current}`,
			`Desired: ${this.data.desired}`,
			`Verify: ${this.data.verify}`,
		];
		if (s.total > 0) {
			parts.push(`\nSteps (${s.done}/${s.total} done):`);
			const tree = this.renderTree();
			if (tree) parts.push(tree);
		}
		const next = this.nextReady();
		if (next) parts.push(`\nNext: ${next.id}`);
		if (this.data.summary) parts.push(`\nSummary: ${this.data.summary}`);
		return parts.join("\n");
	}

	toJSON(): PlanData {
		return structuredClone(this.data);
	}

	private runGates(gates: Gate[]): GateResult[] {
		return gates.map((gate) => this.runGate(gate));
	}

	private runGate(gate: Gate): GateResult {
		switch (gate.type) {
			case "file-exists": {
				const exists = existsSync(gate.target);
				return { gate, passed: exists, output: exists ? "exists" : "not found" };
			}
			case "command": {
				try {
					const output = execSync(gate.target, { encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
					const passed = gate.expect ? output.includes(gate.expect) : true;
					return { gate, passed, output: output.slice(0, 200) };
				} catch (e) {
					return { gate, passed: false, output: e instanceof Error ? e.message.slice(0, 200) : "command failed" };
				}
			}
			case "contains": {
				try {
					const content = readFileSync(gate.target, "utf-8");
					const found = gate.expect ? content.includes(gate.expect) : content.length > 0;
					return { gate, passed: found, output: found ? "found" : `"${gate.expect ?? ""}" not found` };
				} catch {
					return { gate, passed: false, output: "file not readable" };
				}
			}
			case "test": {
				try {
					execSync(`npx vitest run ${gate.target} --reporter=dot`, { encoding: "utf-8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] });
					return { gate, passed: true, output: "tests passed" };
				} catch (e) {
					return { gate, passed: false, output: e instanceof Error ? e.message.slice(0, 200) : "tests failed" };
				}
			}
			default:
				return { gate, passed: false, output: `unknown gate type: ${String(gate.type)}` };
		}
	}
}
