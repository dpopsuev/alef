/**
 * Esc/cancel on boot pickers must exit to the terminal — not advance.
 *
 * These tests encode the correct contract. They fail while cancel is treated
 * as "New session" / "first blueprint".
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import type { SessionStoreFactory } from "@dpopsuev/alef-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pickBlueprint } from "../src/boot/blueprints.js";
import { runPicker } from "../src/client/commands/picker.js";
import { pickSession } from "../src/client/commands/sessions.js";

vi.mock("../src/client/commands/picker.js", () => ({
	runPicker: vi.fn(),
}));

const mockedRunPicker = vi.mocked(runPicker);

const tempDirs: string[] = [];

function tmpCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "alef-picker-cancel-"));
	tempDirs.push(dir);
	return dir;
}

function jsonlFactory(): SessionStoreFactory {
	return {
		create: (cwd) => JsonlSessionStore.create(cwd),
		resume: (cwd, id) => JsonlSessionStore.resume(cwd, id),
		resumeLatest: (cwd) => JsonlSessionStore.resumeLatest(cwd),
		list: (cwd) => JsonlSessionStore.list(cwd),
		listAll: () => JsonlSessionStore.listAll(),
		prune: (cwd) => JsonlSessionStore.prune(cwd),
	};
}

function mockExit(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`process.exit(${code ?? 0})`);
	}) as never);
}

afterEach(() => {
	vi.clearAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("boot picker Esc/cancel exits to terminal", { tags: ["unit"] }, () => {
	it("session picker Esc exits instead of continuing as New session", async () => {
		const cwd = tmpCwd();
		const factory = jsonlFactory();
		await factory.create(cwd);
		const exit = mockExit();

		mockedRunPicker.mockResolvedValueOnce(undefined);
		await expect(pickSession(cwd, factory)).rejects.toThrow(/process\.exit\(0\)/);
		expect(exit).toHaveBeenCalledWith(0);

		exit.mockRestore();
	});

	it("session picker New session still returns undefined without exiting", async () => {
		const cwd = tmpCwd();
		const factory = jsonlFactory();
		await factory.create(cwd);
		const exit = mockExit();

		mockedRunPicker.mockResolvedValueOnce({ value: "__new__", label: "New session" });
		expect(await pickSession(cwd, factory)).toBeUndefined();
		expect(exit).not.toHaveBeenCalled();

		exit.mockRestore();
	});

	it("blueprint picker Esc returns undefined instead of selecting the first blueprint", async () => {
		mockedRunPicker.mockResolvedValueOnce(undefined);

		const choices = [
			{ name: "coding", description: "first", path: "/tmp/coding.yaml" },
			{ name: "research", description: "second", path: "/tmp/research.yaml" },
		];
		expect(await pickBlueprint(choices)).toBeUndefined();
	});
});
