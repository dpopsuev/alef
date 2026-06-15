/**
 * Container.insertAt — prepend support for session history lazy-eager load.
 *
 * Given/When/Then:
 *   Given a Container with existing children
 *   When insertAt(0, component) is called
 *   Then the new component appears first in children
 *   And render() output starts with the new component's content
 */

import { describe, expect, it } from "vitest";
import { Container, Text } from "../src/index.js";

describe("Container.insertAt", () => {
	it("insertAt(0, c) prepends the component", () => {
		const container = new Container();
		const a = new Text("line A", 0, 0);
		const b = new Text("line B", 0, 0);
		container.addChild(a);
		container.insertAt(0, b);
		expect(container.children[0]).toBe(b);
		expect(container.children[1]).toBe(a);
	});

	it("insertAt(1, c) inserts after the first child", () => {
		const container = new Container();
		const a = new Text("a", 0, 0);
		const b = new Text("b", 0, 0);
		const c = new Text("c", 0, 0);
		container.addChild(a);
		container.addChild(b);
		container.insertAt(1, c);
		expect(container.children[0]).toBe(a);
		expect(container.children[1]).toBe(c);
		expect(container.children[2]).toBe(b);
	});

	it("insertAt beyond length appends", () => {
		const container = new Container();
		const a = new Text("a", 0, 0);
		const b = new Text("b", 0, 0);
		container.addChild(a);
		container.insertAt(99, b);
		expect(container.children[container.children.length - 1]).toBe(b);
	});

	it("render() order reflects insertAt(0, c) prepend", () => {
		const container = new Container();
		container.addChild(new Text("second", 0, 0));
		container.insertAt(0, new Text("first", 0, 0));
		const lines = container.render(80);
		expect(lines[0]).toContain("first");
		expect(lines[1]).toContain("second");
	});
});
