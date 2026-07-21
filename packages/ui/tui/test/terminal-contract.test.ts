/**
 * Terminal contract tests — run the same assertions against every
 * Terminal implementation to verify Liskov substitutability.
 */

import { describe, expect, it } from "vitest";
import { MockTerminal } from "../src/mock-terminal.js";
import type { Terminal } from "../src/terminal.js";
import { VirtualTerminal } from "./virtual-terminal.js";

function terminalSuite(name: string, factory: () => Terminal) {
	describe(`Terminal contract: ${name}`, { tags: ["unit"] }, () => {
		it("columns and rows return positive integers", () => {
			const t = factory();
			expect(t.columns).toBeGreaterThan(0);
			expect(t.rows).toBeGreaterThan(0);
			expect(Number.isInteger(t.columns)).toBe(true);
			expect(Number.isInteger(t.rows)).toBe(true);
		});

		it("dec2026Active returns a boolean", () => {
			const t = factory();
			expect(typeof t.dec2026Active).toBe("boolean");
		});

		it("start and stop are callable without error", () => {
			const t = factory();
			t.start(
				() => {},
				() => {},
			);
			t.stop();
		});

		it("write accepts strings without throwing", () => {
			const t = factory();
			t.start(
				() => {},
				() => {},
			);
			t.write("hello");
			t.write("\x1b[2J");
			t.write("");
			t.stop();
		});

		it("hideCursor and showCursor are callable", () => {
			const t = factory();
			t.start(
				() => {},
				() => {},
			);
			t.hideCursor();
			t.showCursor();
			t.stop();
		});

		it("start delivers input to the onInput callback", () => {
			const t = factory();
			const received: string[] = [];
			t.start(
				(data) => received.push(data),
				() => {},
			);

			if ("simulateInput" in t && typeof (t as any).simulateInput === "function") {
				(t as any).simulateInput("a");
				expect(received).toContain("a");
			} else if ("sendInput" in t && typeof (t as any).sendInput === "function") {
				(t as any).sendInput("a");
				expect(received).toContain("a");
			}

			t.stop();
		});
	});
}

terminalSuite("MockTerminal", () => new MockTerminal(80, 24));
terminalSuite("VirtualTerminal", () => new VirtualTerminal(80, 24));
