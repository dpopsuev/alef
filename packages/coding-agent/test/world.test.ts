/**
 * Tests for the ECS World — entities, components, edges, queries.
 * Ported from tangle/world/world_test.go.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type Component, type ComponentType, type DiffKind, World } from "../src/board/world.js";

const COLOR_TYPE: ComponentType = "color";
const HEALTH_TYPE: ComponentType = "health";

interface ColorComponent extends Component {
	componentType: typeof COLOR_TYPE;
	name: string;
	hex: string;
}
interface HealthComponent extends Component {
	componentType: typeof HEALTH_TYPE;
	status: string;
}

function color(name: string, hex: string): ColorComponent {
	return { componentType: COLOR_TYPE, name, hex };
}
function health(status: string): HealthComponent {
	return { componentType: HEALTH_TYPE, status };
}

describe("World — entities", () => {
	let w: World;
	beforeEach(() => {
		w = new World();
	});

	it("spawn creates unique IDs", () => {
		const a = w.spawn();
		const b = w.spawn();
		expect(a).not.toBe(b);
		expect(w.count()).toBe(2);
	});

	it("despawn removes entity", () => {
		const id = w.spawn();
		w.despawn(id);
		expect(w.isAlive(id)).toBe(false);
		expect(w.count()).toBe(0);
	});

	it("all() returns living entities", () => {
		const a = w.spawn();
		const b = w.spawn();
		w.despawn(a);
		expect(w.all()).toEqual([b]);
	});
});

describe("World — components", () => {
	let w: World;
	beforeEach(() => {
		w = new World();
	});

	it("attach and get", () => {
		const id = w.spawn();
		w.attach(id, color("crimson", "#DC143C"));
		const c = w.get(id, COLOR_TYPE) as ColorComponent;
		expect(c.name).toBe("crimson");
		expect(c.hex).toBe("#DC143C");
	});

	it("attach replaces existing component", () => {
		const id = w.spawn();
		w.attach(id, color("crimson", "#DC143C"));
		w.attach(id, color("azure", "#007FFF"));
		expect((w.get(id, COLOR_TYPE) as ColorComponent).name).toBe("azure");
	});

	it("get returns undefined for missing component", () => {
		const id = w.spawn();
		expect(w.get(id, COLOR_TYPE)).toBeUndefined();
	});

	it("has checks component existence", () => {
		const id = w.spawn();
		expect(w.has(id, COLOR_TYPE)).toBe(false);
		w.attach(id, color("crimson", "#DC143C"));
		expect(w.has(id, COLOR_TYPE)).toBe(true);
	});

	it("detach removes component", () => {
		const id = w.spawn();
		w.attach(id, color("crimson", "#DC143C"));
		w.detach(id, COLOR_TYPE);
		expect(w.has(id, COLOR_TYPE)).toBe(false);
	});

	it("attach on dead entity throws", () => {
		const id = w.spawn();
		w.despawn(id);
		expect(() => w.attach(id, color("x", "#000"))).toThrow("dead entity");
	});

	it("query finds entities by component type", () => {
		const a = w.spawn();
		const b = w.spawn();
		const c = w.spawn();
		w.attach(a, color("crimson", "#DC143C"));
		w.attach(b, health("running"));
		w.attach(c, color("azure", "#007FFF"));
		w.attach(c, health("idle"));

		expect(w.query(COLOR_TYPE).sort()).toEqual([a, c].sort());
		expect(w.query(HEALTH_TYPE).sort()).toEqual([b, c].sort());
	});
});

describe("World — diff hooks", () => {
	it("fires on attach", () => {
		const w = new World();
		const events: Array<{ kind: DiffKind; ct: string }> = [];
		w.onDiff((_id, ct, kind) => events.push({ kind, ct }));

		const id = w.spawn();
		w.attach(id, color("crimson", "#DC143C"));

		expect(events).toEqual([{ kind: "attached", ct: COLOR_TYPE }]);
	});

	it("fires updated on replace", () => {
		const w = new World();
		const events: Array<{ kind: DiffKind }> = [];
		w.onDiff((_id, _ct, kind) => events.push({ kind }));

		const id = w.spawn();
		w.attach(id, color("a", "#000"));
		w.attach(id, color("b", "#111"));

		expect(events).toEqual([{ kind: "attached" }, { kind: "updated" }]);
	});

	it("fires on detach", () => {
		const w = new World();
		const events: DiffKind[] = [];
		w.onDiff((_id, _ct, kind) => events.push(kind));

		const id = w.spawn();
		w.attach(id, color("a", "#000"));
		w.detach(id, COLOR_TYPE);

		expect(events).toEqual(["attached", "detached"]);
	});
});

describe("World — edges", () => {
	let w: World;
	beforeEach(() => {
		w = new World();
	});

	it("link creates directed edge", () => {
		const a = w.spawn();
		const b = w.spawn();
		w.link(a, "supervises", b);
		expect(w.edgeCount()).toBe(1);
		expect(w.neighbors(a, "supervises", "outbound")).toEqual([b]);
		expect(w.neighbors(b, "supervises", "inbound")).toEqual([a]);
	});

	it("unlink removes edge", () => {
		const a = w.spawn();
		const b = w.spawn();
		w.link(a, "supervises", b);
		w.unlink(a, "supervises", b);
		expect(w.edgeCount()).toBe(0);
	});

	it("rejects self-loops", () => {
		const a = w.spawn();
		expect(() => w.link(a, "supervises", a)).toThrow("self-loop");
	});

	it("rejects duplicate edges", () => {
		const a = w.spawn();
		const b = w.spawn();
		w.link(a, "supervises", b);
		expect(() => w.link(a, "supervises", b)).toThrow("duplicate");
	});

	it("detects cycles in DAG relations", () => {
		const a = w.spawn();
		const b = w.spawn();
		const c = w.spawn();
		w.link(a, "supervises", b);
		w.link(b, "supervises", c);
		expect(() => w.link(c, "supervises", a)).toThrow("cycle");
	});

	it("allows non-DAG relation cycles", () => {
		const a = w.spawn();
		const b = w.spawn();
		w.link(a, "communicates_with", b);
		w.link(b, "communicates_with", a); // not a DAG relation — allowed
		expect(w.edgeCount()).toBe(2);
	});

	it("neighbors with both direction", () => {
		const a = w.spawn();
		const b = w.spawn();
		const c = w.spawn();
		w.link(a, "assigned_to", b);
		w.link(c, "assigned_to", b);
		expect(w.neighbors(b, "assigned_to", "inbound").sort()).toEqual([a, c].sort());
		expect(w.neighbors(b, "assigned_to", "both").sort()).toEqual([a, c].sort());
	});

	it("edgesOf returns all edges for entity", () => {
		const a = w.spawn();
		const b = w.spawn();
		const c = w.spawn();
		w.link(a, "supervises", b);
		w.link(a, "assigned_to", c);
		expect(w.edgesOf(a)).toHaveLength(2);
	});

	it("despawn removes entity edges", () => {
		const a = w.spawn();
		const b = w.spawn();
		w.link(a, "supervises", b);
		w.despawn(b);
		expect(w.edgeCount()).toBe(0);
	});
});
