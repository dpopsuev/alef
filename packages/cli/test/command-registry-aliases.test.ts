import { describe, expect, it, vi } from "vitest";
import { registry } from "../src/client/commands/commands.js";
import type { TuiHandlerContext } from "../src/client/commands/types.js";
import { handleColonCommand } from "../src/client/handlers.js";

describe("command registry quit aliases", { tags: ["unit"] }, () => {
	it("registers q, quit, and exit to the same Quit command", () => {
		const q = registry.find("q");
		const quit = registry.find("quit");
		const exit = registry.find("exit");
		expect(q).toBeDefined();
		expect(quit).toBe(q);
		expect(exit).toBe(q);
		expect(q!.description).toBe("Quit");
		expect(registry.aliasesOf("q")).toEqual(["quit", "exit"]);
	});

	it("lists quit in completions alongside q", () => {
		const names = registry.listCompletions().map((c) => c.name);
		expect(names).toContain("q");
		expect(names).toContain("quit");
		expect(names).toContain("exit");
	});

	it("dispatches :quit the same as :q", () => {
		const dispose = vi.fn();
		const stop = vi.fn();
		const ctx = {
			session: { dispose },
			tui: { stop, requestRender: vi.fn() },
			writer: { addNotice: vi.fn() },
		} as unknown as TuiHandlerContext;
		expect(handleColonCommand(":quit", ctx)).toBe(true);
		expect(dispose).toHaveBeenCalled();
		expect(stop).toHaveBeenCalled();
	});
});
