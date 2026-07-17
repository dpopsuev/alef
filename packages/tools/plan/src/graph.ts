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

/** Claim metadata for parallel workers coordinating on a ready step. */
export interface StepClaim {
	owner: string;
	state: "reserved" | "active";
	token: string;
	claimedAt: number;
	leaseExpiresAt?: number;
	note?: string;
}

/** Plan-level custody (Parchment Claim-shaped) — independent of step claims. */
export interface PlanCustody {
	owner: string;
	from?: string;
	handedAt: number;
	token: string;
	leaseExpiresAt?: number;
	note?: string;
}

/** A single step in the plan DAG with gates and optional inspector. */
export interface Step {
	id: string;
	label: string;
	dependsOn: string[];
	status: StepStatus;
	claim?: StepClaim;
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
	custody?: PlanCustody;
	summary?: string;
	createdAt: number;
	updatedAt: number;
}

/** Directed acyclic step graph with gate-guarded transitions and disk persistence. */
export class PlanGraph {
	private data: PlanData;
	private diskPath: string | null;
	private stepIndex = new Map<string, Step>();
	private dependentsIndex = new Map<string, string[]>();
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
		this.dependentsIndex.clear();
		for (const step of this.data.steps) {
			this.stepIndex.set(step.id, step);
			for (const dep of step.dependsOn) {
				const deps = this.dependentsIndex.get(dep) ?? [];
				deps.push(step.id);
				this.dependentsIndex.set(dep, deps);
			}
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

	addStep(label: string, dependsOn: string[] = [], gates: Gate[] = [], inspector?: Inspector): Step {
		const words = label.trim().split(/\s+/);
		if (words.length < MIN_LABEL_WORDS) throw new Error(`Step label too short (${words.length} words, min ${MIN_LABEL_WORDS}): "${label}"`);
		if (words.length > MAX_LABEL_WORDS) throw new Error(`Step label too long (${words.length} words, max ${MAX_LABEL_WORDS}): "${label}"`);
		const normalizedLabel = label.trim().toLowerCase();
		if (this.data.steps.some((step) => step.label.trim().toLowerCase() === normalizedLabel)) {
			throw new Error(`duplicate step label: "${label}"`);
		}
		for (const dep of dependsOn) {
			if (!this.stepIndex.has(dep)) throw new Error(`dependency step ${dep} not found`);
		}

		const id = this.slugify(label);
		const step: Step = { id, label, dependsOn, status: "pending", gates };
		if (inspector) step.inspector = inspector;

		this.data.steps.push(step);
		this.stepIndex.set(id, step);
		this.seq++;

		for (const dep of dependsOn) {
			const deps = this.dependentsIndex.get(dep) ?? [];
			deps.push(id);
			this.dependentsIndex.set(dep, deps);
		}

		if (this.hasCycle()) {
			this.data.steps.pop();
			this.stepIndex.delete(id);
			this.seq--;
			for (const dep of dependsOn) {
				const deps = this.dependentsIndex.get(dep);
				if (deps) deps.pop();
			}
			throw new Error(`adding step "${label}" would create a cycle`);
		}

		this.touch();
		return step;
	}

	private hasCycle(): boolean {
		const inDegree = new Map<string, number>();
		for (const step of this.data.steps) {
			if (!inDegree.has(step.id)) inDegree.set(step.id, 0);
			for (const dep of step.dependsOn) {
				inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
				if (!inDegree.has(dep)) inDegree.set(dep, 0);
			}
		}
		const queue: string[] = [];
		for (const [id, deg] of inDegree) {
			if (deg === 0) queue.push(id);
		}
		let visited = 0;
		while (queue.length > 0) {
			const current = queue.shift()!;
			visited++;
			for (const dependent of this.dependentsIndex.get(current) ?? []) {
				const newDeg = (inDegree.get(dependent) ?? 1) - 1;
				inDegree.set(dependent, newDeg);
				if (newDeg === 0) queue.push(dependent);
			}
		}
		return visited < this.data.steps.length;
	}

	startStep(id: string): Step | null {
		return this.startClaimedStep(id);
	}

	claimStep(
		id: string,
		owner: string,
		opts: { leaseMs?: number; note?: string } = {},
	): { step: Step; token: string } | null {
		const step = this.stepIndex.get(id);
		if (!step) return null;
		this.clearExpiredClaim(step);
		if (!this.isReady(step) || step.claim) return null;
		const token = `claim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		step.claim = {
			owner,
			state: "reserved",
			token,
			claimedAt: Date.now(),
			leaseExpiresAt: opts.leaseMs ? Date.now() + opts.leaseMs : undefined,
			note: opts.note,
		};
		this.touch();
		return { step, token };
	}

	heartbeatClaim(id: string, token: string, leaseMs?: number): Step | null {
		const step = this.stepIndex.get(id);
		if (!step) return null;
		this.clearExpiredClaim(step);
		if (!step.claim || step.claim.token !== token) return null;
		if (leaseMs) step.claim.leaseExpiresAt = Date.now() + leaseMs;
		this.touch();
		return step;
	}

	releaseClaim(id: string, token: string): Step | null {
		const step = this.stepIndex.get(id);
		if (!step) return null;
		this.clearExpiredClaim(step);
		if (!step.claim || step.claim.token !== token) return null;
		if (step.status === "active") step.status = "pending";
		delete step.claim;
		this.touch();
		return step;
	}

	startClaimedStep(id: string, token?: string): Step | null {
		const step = this.stepIndex.get(id);
		if (!step || (step.status !== "pending" && step.status !== "failed")) return null;
		this.clearExpiredClaim(step);
		if (step.claim) {
			if (token !== step.claim.token) return null;
			step.claim = { ...step.claim, state: "active" };
		} else if (!this.isReady(step) && step.status !== "failed") {
			return null;
		}
		step.status = "active";
		step.startedAt = Date.now();
		if (this.data.phase === "open") this.data.phase = "working";
		this.touch();
		return step;
	}

	completeStep(id: string, result?: string, token?: string): { step: Step; gateResults: GateResult[] } | null {
		const step = this.stepIndex.get(id);
		if (!step || step.status !== "active") return null;
		this.clearExpiredClaim(step);
		if (step.claim && step.claim.token !== token) return null;

		const gateResults = this.runGates(step.gates);
		step.gateResults = gateResults;
		if (result) step.result = result;

		const allPassed = gateResults.every((g) => g.passed);
		if (allPassed) {
			step.status = "done";
			step.completedAt = Date.now();
			delete step.claim;
		} else {
			step.status = "failed";
			step.result = gateResults
				.filter((g) => !g.passed)
				.map((g) => `gate failed: ${g.gate.type} ${g.gate.target} — ${g.output}`)
				.join("; ");
			delete step.claim;
		}
		this.touch();
		return { step, gateResults };
	}

	failStep(id: string, reason: string, token?: string): Step | null {
		const step = this.stepIndex.get(id);
		if (!step || step.status !== "active") return null;
		this.clearExpiredClaim(step);
		if (step.claim && step.claim.token !== token) return null;
		step.status = "failed";
		step.result = reason;
		delete step.claim;
		this.touch();
		return step;
	}

	dropStep(id: string, token?: string): Step | null {
		const step = this.stepIndex.get(id);
		if (!step || step.status === "done" || step.status === "dropped") return null;
		this.clearExpiredClaim(step);
		if (step.claim && step.claim.token !== token) return null;
		step.status = "dropped";
		delete step.claim;
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

	dependents(stepId: string): Step[] {
		return (this.dependentsIndex.get(stepId) ?? [])
			.map((id) => this.stepIndex.get(id))
			.filter((s): s is Step => s !== undefined);
	}

	roots(): Step[] {
		return this.data.steps.filter((s) => s.dependsOn.length === 0);
	}

	private clearExpiredClaim(step: Step): void {
		if (!step.claim?.leaseExpiresAt) return;
		if (step.claim.leaseExpiresAt <= Date.now()) {
			delete step.claim;
		}
	}

	private clearExpiredCustody(): void {
		const custody = this.data.custody;
		if (!custody?.leaseExpiresAt) return;
		if (custody.leaseExpiresAt <= Date.now()) {
			delete this.data.custody;
			this.touch();
		}
	}

	/** Transfer plan custody to `to`. Returns new custody + token. */
	handoff(
		to: string,
		opts: { from?: string; note?: string; leaseMs?: number; token?: string } = {},
	): { custody: PlanCustody; token: string } {
		const token = opts.token ?? `custody-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		const custody: PlanCustody = {
			owner: to,
			from: opts.from,
			handedAt: Date.now(),
			token,
			leaseExpiresAt: opts.leaseMs ? Date.now() + opts.leaseMs : undefined,
			note: opts.note,
		};
		this.data.custody = custody;
		this.touch();
		return { custody, token };
	}

	/** Current custody, or null if none / lease expired. */
	custody(): PlanCustody | null {
		this.clearExpiredCustody();
		return this.data.custody ?? null;
	}

	/**
	 * Clear custody. Requires matching token unless `rootAuthority` is true.
	 * Returns true when custody was cleared.
	 */
	revokeCustody(opts: { token?: string; rootAuthority?: boolean } = {}): boolean {
		this.clearExpiredCustody();
		if (!this.data.custody) return false;
		if (!opts.rootAuthority && opts.token !== this.data.custody.token) return false;
		delete this.data.custody;
		this.touch();
		return true;
	}

	private isReady(step: Step): boolean {
		this.clearExpiredClaim(step);
		if (step.status !== "pending") return false;
		if (step.claim) return false;
		if (step.dependsOn.length === 0) return true;
		return step.dependsOn.every((dep) => this.stepIndex.get(dep)?.status === "done");
	}

	nextReady(): Step | null {
		for (const step of this.data.steps) {
			if (this.isReady(step)) return step;
		}
		return null;
	}

	allReady(): Step[] {
		return this.data.steps.filter((s) => this.isReady(s));
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
				return "▲";
			case "dropped":
				return "×";
			default:
				return "○";
		}
	}

	/** Collapse legacy duplicate labels (prefer active > failed > done > pending). */
	private stepsForDisplay(): Step[] {
		const rank: Record<StepStatus, number> = {
			active: 4,
			failed: 3,
			done: 2,
			pending: 1,
			dropped: 0,
		};
		const byLabel = new Map<string, Step>();
		const order: string[] = [];
		for (const step of this.data.steps) {
			const key = step.label.trim().toLowerCase();
			const existing = byLabel.get(key);
			if (!existing) {
				byLabel.set(key, step);
				order.push(key);
				continue;
			}
			if (rank[step.status] > rank[existing.status]) byLabel.set(key, step);
		}
		return order.map((key) => byLabel.get(key)!);
	}

	/** Sticky TUI strip: header counts + status rows (Alef geometric glyphs, not checkmarks). */
	renderTree(): string {
		const displaySteps = this.stepsForDisplay();
		const done = displaySteps.filter((step) => step.status === "done").length;
		const active = displaySteps.filter((step) => step.status === "active").length;
		const pending = displaySteps.filter((step) => step.status === "pending").length;
		const working = active > 0 ? active : pending > 0 ? 1 : 0;
		this.clearExpiredCustody();
		const custodyOwner = this.data.custody?.owner;
		const custodyLine = custodyOwner ? ` · custody ${custodyOwner}` : "";
		const header =
			displaySteps.length === 0
				? `Plan · no steps yet${custodyLine}`
				: `Plan · working on ${working} · ${done}/${displaySteps.length} done${custodyLine}`;
		const lines: string[] = [header];

		for (const step of displaySteps) {
			const marker = PlanGraph.glyph(step.status);
			const focus = step.status === "active" ? "  ◄" : "";
			const claim =
				step.claim?.owner
					? step.claim.state === "reserved"
						? `  · reserved ${step.claim.owner}`
						: `  · ${step.claim.owner}`
					: "";
			lines.push(`  ${marker} ${step.label}${claim}${focus}`);
			if (step.status === "active") {
				for (const g of step.gates) {
					const gateStr = g.expect ? `${g.type}: ${g.target} = ${g.expect}` : `${g.type}: ${g.target}`;
					lines.push(`      gate · ${gateStr}`);
				}
				if (step.inspector) {
					lines.push(`      inspect · ${step.inspector.type}: ${step.inspector.prompt.slice(0, 60)}`);
				}
			}
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
