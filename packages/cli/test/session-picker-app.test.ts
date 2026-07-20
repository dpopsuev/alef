/**
 * In-TUI session picker tests.
 *
 * Validates that pickSessionInTui renders a SelectList in the scrollback,
 * handles navigation and selection, and returns the correct session ID.
 */

import type { SessionListEntry, SessionStoreFactory } from "@dpopsuev/alef-storage";
import { describe, expect, it } from "vitest";
import type { TuiShell } from "../src/client/boot-types.js";
import { pickSessionInTui } from "../src/client/session-picker-app.js";

/** Stub SessionStoreFactory that returns canned entries. */
function stubSessions(entries: SessionListEntry[]): SessionStoreFactory {
	return {
		list: async () => entries,
		listAll: async () => entries,
		create: async () => ({ id: "new-id", path: "/tmp/new" }) as never,
		resume: async () => ({}) as never,
		resumeLatest: async () => null as never,
		prune: async () => 0,
	};
}

/** Minimal TuiShell stub for testing. */
function stubShell(): TuiShell & { simulateInput(data: string): void } {
	let rawHandler: ((data: string) => boolean) | undefined;
	const children: unknown[] = [];

	return {
		simulateInput(data: string) {
			rawHandler?.(data);
		},
		tui: {
			set onRawInput(fn: ((data: string) => boolean) | undefined) {
				rawHandler = fn ?? undefined;
			},
			get onRawInput() {
				return rawHandler;
			},
			requestRender() {},
			stop() {},
		} as TuiShell["tui"],
		t: {} as TuiShell["t"],
		output: {} as TuiShell["output"],
		input: {} as TuiShell["input"],
		footer: {} as TuiShell["footer"],
		writer: {
			addNotice() {},
			container: {
				addChild(c: unknown) {
					children.push(c);
				},
				removeChild(c: unknown) {
					const i = children.indexOf(c);
					if (i >= 0) children.splice(i, 1);
				},
			},
		} as unknown as TuiShell["writer"],
		editor: {} as TuiShell["editor"],
		chrome: {} as TuiShell["chrome"],
		tuiStore: {} as TuiShell["tuiStore"],
		cwd: "/test",
		handleBootEvent() {},
		stopped: new Promise(() => {}),
	};
}

describe("pickSessionInTui", { tags: ["unit"] }, () => {
	it("returns undefined when no sessions exist", async () => {
		const shell = stubShell();
		const result = await pickSessionInTui(shell, {
			cwd: "/test",
			sessions: stubSessions([]),
		});
		expect(result).toBeUndefined();
	});

	it("resolves with session ID on Enter", async () => {
		const shell = stubShell();
		const entries: SessionListEntry[] = [
			{ id: "sess-1", name: "First", mtime: new Date(), tags: [], path: "/tmp/s1" },
			{ id: "sess-2", name: "Second", mtime: new Date(), tags: [], path: "/tmp/s2" },
		];

		const resultP = pickSessionInTui(shell, {
			cwd: "/test",
			sessions: stubSessions(entries),
		});

		// Wait for the picker to mount
		await new Promise((r) => setTimeout(r, 10));

		// Move down past "New session" to "First", then enter
		shell.simulateInput("j");
		shell.simulateInput("\r");

		const result = await resultP;
		expect(result).toBe("sess-1");
	});

	it("returns undefined when New session is selected", async () => {
		const shell = stubShell();
		const entries: SessionListEntry[] = [
			{ id: "sess-1", name: "First", mtime: new Date(), tags: [], path: "/tmp/s1" },
		];

		const resultP = pickSessionInTui(shell, {
			cwd: "/test",
			sessions: stubSessions(entries),
		});

		await new Promise((r) => setTimeout(r, 10));

		// "New session" is first item, press Enter immediately
		shell.simulateInput("\r");

		const result = await resultP;
		expect(result).toBeUndefined();
	});
});
