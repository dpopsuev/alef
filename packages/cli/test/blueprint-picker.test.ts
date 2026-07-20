/**
 * In-TUI blueprint picker tests.
 */

import { describe, expect, it } from "vitest";
import { type BlueprintChoice, pickBlueprintInTui } from "../src/client/blueprint-picker-app.js";
import type { TuiShell } from "../src/client/boot-types.js";

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

describe("pickBlueprintInTui", { tags: ["unit"] }, () => {
	it("returns single blueprint immediately without picker", async () => {
		const shell = stubShell();
		const choices: BlueprintChoice[] = [{ name: "coding", description: "Code agent", path: "coding" }];
		const result = await pickBlueprintInTui(shell, choices);
		expect(result?.name).toBe("coding");
	});

	it("returns undefined for empty choices", async () => {
		const shell = stubShell();
		const result = await pickBlueprintInTui(shell, []);
		expect(result).toBeUndefined();
	});

	it("resolves with selected blueprint on Enter", async () => {
		const shell = stubShell();
		const choices: BlueprintChoice[] = [
			{ name: "coding", description: "Code agent", path: "coding" },
			{ name: "research", description: "Research agent", path: "research" },
		];

		const resultP = pickBlueprintInTui(shell, choices);
		await new Promise((r) => setTimeout(r, 10));

		shell.simulateInput("\r");
		const result = await resultP;
		expect(result?.name).toBe("coding");
	});

	it("navigates with j/k and selects", async () => {
		const shell = stubShell();
		const choices: BlueprintChoice[] = [
			{ name: "coding", description: "Code agent", path: "coding" },
			{ name: "research", description: "Research agent", path: "research" },
		];

		const resultP = pickBlueprintInTui(shell, choices);
		await new Promise((r) => setTimeout(r, 10));

		shell.simulateInput("j");
		shell.simulateInput("\r");
		const result = await resultP;
		expect(result?.name).toBe("research");
	});
});
