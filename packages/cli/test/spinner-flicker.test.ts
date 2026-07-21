/**
 * Spinner stability test -- verify the thinking spinner doesn't corrupt
 * the viewport during rapid re-renders.
 *
 * Uses the production bootTuiShell + wireSession path with VirtualTerminal.
 * Simulates tool-start followed by rapid chunk events (high pressure),
 * then checks viewport integrity after many spinner ticks.
 */

import type { AgentEvent, Session } from "@dpopsuev/alef-session/contracts";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../ui/tui/test/virtual-terminal.js";
import type { ResolvedSession, WireSessionDeps } from "../src/client/boot-types.js";
import { getTheme, loadTheme } from "../src/client/theme.js";
import { bootTuiShell, wireSession } from "../src/client/tui-shell.js";

async function settle(ms = 50): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
	await new Promise<void>((r) => process.nextTick(r));
}

function ensureTheme(): void {
	try {
		getTheme();
	} catch {
		loadTheme(undefined, undefined, undefined, true, []);
	}
}

function createTestSession(): Session & { emit(event: AgentEvent): void } {
	const observers = new Set<(event: AgentEvent) => void>();
	return {
		state: { id: "test", modelId: "test-model", contextWindow: 128000 },
		getModel: () => "test-model",
		setModel: () => {},
		getThinking: () => "",
		setThinking: () => {},
		setTurnController: () => {},
		dispose: () => {},
		subscribe: (obs) => {
			observers.add(obs);
			return () => observers.delete(obs);
		},
		emit(event) {
			for (const obs of observers) obs(event);
		},
	};
}

function resolved(session: Session): ResolvedSession {
	return {
		session,
		sessionId: "test",
		modelId: "test-model",
		contextWindow: 128000,
		isNew: true,
		getModel: () => "test-model",
		setModel: () => {},
		getThinking: () => "",
		setThinking: () => {},
		humanAddress: "@you",
		agentAddress: "@alef",
	};
}

function testDeps(): WireSessionDeps {
	return {
		signalHandlers: new Map(),
		isCompacted: () => false,
		checkForUpdate: async () => null,
	};
}

describe("spinner stability", { tags: ["unit"] }, () => {
	it("rapid chunk events during tool-start do not corrupt viewport", async () => {
		ensureTheme();
		const terminal = new VirtualTerminal(80, 20);
		const session = createTestSession();

		const shell = bootTuiShell({ cwd: "/tmp/test", terminal });
		wireSession(shell, resolved(session), testDeps());
		await settle();

		// Start a tool call -- this activates the spinner
		session.emit({
			type: "tool-start",
			callId: "c1",
			name: "fs.read",
			args: { path: "large-file.ts" },
		});
		await settle();

		// Simulate rapid chunk events (high pressure -> fast spinner)
		for (let i = 0; i < 20; i++) {
			session.emit({ type: "tool-chunk", callId: "c1", text: `line ${i}\n` });
			// Let the spinner tick between chunks
			await new Promise<void>((r) => setTimeout(r, 30));
		}

		await settle(100);

		const viewport = await terminal.flushAndGetViewport();

		// Check for adjacent duplicate lines (corruption signal)
		for (let i = 1; i < viewport.length; i++) {
			const prev = viewport[i - 1]!.trim();
			const curr = viewport[i]!.trim();
			if (prev && curr && prev.length > 10 && prev === curr) {
				expect.fail(`adjacent duplicate at rows ${i - 1}/${i}: "${prev.slice(0, 60)}"`);
			}
		}

		// Tool call should be visible
		const allText = terminal.getScrollBuffer().join("\n");
		expect(allText).toContain("fs.read");

		shell.tui.stop();
	});

	it("spinner ticks between two tool calls maintain viewport integrity", async () => {
		ensureTheme();
		const terminal = new VirtualTerminal(80, 16);
		const session = createTestSession();

		const shell = bootTuiShell({ cwd: "/tmp/test", terminal });
		wireSession(shell, resolved(session), testDeps());
		await settle();

		// First tool call with spinner
		session.emit({ type: "tool-start", callId: "c1", name: "shell.exec", args: { command: "npm test" } });
		await settle(100); // Let spinner tick several times

		// Complete first, start second immediately
		session.emit({
			type: "tool-end",
			callId: "c1",
			elapsedMs: 500,
			ok: true,
			display: "All tests passed",
			displayKind: "text/plain",
		});
		session.emit({ type: "tool-start", callId: "c2", name: "fs.edit", args: { path: "file.ts" } });
		await settle(100);

		session.emit({
			type: "tool-end",
			callId: "c2",
			elapsedMs: 80,
			ok: true,
			display: "edit file.ts\n-old\n+new",
			displayKind: "text/x-diff",
		});
		await settle();

		const _viewport = await terminal.flushAndGetViewport();
		const allText = terminal.getScrollBuffer().join("\n");

		expect(allText).toContain("shell.exec");
		expect(allText).toContain("file.ts");

		shell.tui.stop();
	});

	it("many concurrent tool calls with spinners stay stable", async () => {
		ensureTheme();
		const terminal = new VirtualTerminal(80, 20);
		const session = createTestSession();

		const shell = bootTuiShell({ cwd: "/tmp/test", terminal });
		wireSession(shell, resolved(session), testDeps());
		await settle();

		// Start 4 concurrent tool calls
		for (let i = 0; i < 4; i++) {
			session.emit({
				type: "tool-start",
				callId: `c${i}`,
				name: `tool-${i}`,
				args: { idx: i },
			});
		}
		await settle(150); // Let spinners tick

		// Complete them in reverse order with chunks between
		for (let i = 3; i >= 0; i--) {
			session.emit({ type: "tool-chunk", callId: `c${i}`, text: `output ${i}` });
			await new Promise<void>((r) => setTimeout(r, 40));
			session.emit({
				type: "tool-end",
				callId: `c${i}`,
				elapsedMs: 100 + i * 50,
				ok: true,
			});
			await settle(50);
		}

		const viewport = await terminal.flushAndGetViewport();

		// No adjacent duplicates
		for (let i = 1; i < viewport.length; i++) {
			const prev = viewport[i - 1]!.trim();
			const curr = viewport[i]!.trim();
			if (prev && curr && prev.length > 10 && prev === curr) {
				expect.fail(`adjacent duplicate at rows ${i - 1}/${i}: "${prev.slice(0, 60)}"`);
			}
		}

		shell.tui.stop();
	});
});
