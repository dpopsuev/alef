/**
 * :command subcommand / argument completions — dimmed hints in SelectList.
 */

import { CombinedAutocompleteProvider } from "@dpopsuev/alef-tui";
import { describe, expect, it } from "vitest";
import { registry } from "../src/client/commands/commands.js";
import { completeCommandArguments } from "../src/client/commands/types.js";

describe("completeCommandArguments", { tags: ["unit"] }, () => {
	const args = [
		{ value: "list", description: "List all plans" },
		{ value: "focus", description: "Focus a plan" },
		{ value: "close", description: "Close focused plan" },
	];

	it("returns all verbs for an empty prefix", () => {
		const items = completeCommandArguments(args, "");
		expect(items?.map((i) => i.value)).toEqual(["list", "focus", "close"]);
		expect(items?.[0]?.description).toBe("List all plans");
	});

	it("filters by prefix", () => {
		expect(completeCommandArguments(args, "f")?.map((i) => i.value)).toEqual(["focus"]);
	});

	it("stops after the first token", () => {
		expect(completeCommandArguments(args, "focus ")).toBeNull();
		expect(completeCommandArguments(args, "focus abc")).toBeNull();
	});
});

describe("registry.toSlashCommands", { tags: ["unit"] }, () => {
	it("exposes argumentHint and subcommand completions for :plan", async () => {
		const plan = registry.toSlashCommands().find((c) => c.name === "plan");
		expect(plan).toBeDefined();
		expect(plan!.argumentHint).toContain("list");
		expect(plan!.description).toBe("Workspace plans");

		const items = await plan!.getArgumentCompletions?.("");
		expect(items?.map((i) => i.value)).toEqual(expect.arrayContaining(["list", "focus", "backlog", "close"]));
		expect(items?.find((i) => i.value === "list")?.description).toBe("List all plans");
	});

	it("exposes theme and think argument completions", async () => {
		const theme = registry.toSlashCommands().find((c) => c.name === "theme");
		const think = registry.toSlashCommands().find((c) => c.name === "think");
		expect(theme?.argumentHint).toBe("<name>");
		expect((await theme!.getArgumentCompletions?.("ak"))?.map((i) => i.value)).toEqual(["akko"]);
		expect((await think!.getArgumentCompletions?.("hi"))?.map((i) => i.value)).toEqual(["high"]);
	});
});

describe("CombinedAutocompleteProvider with registry slash commands", { tags: ["unit"] }, () => {
	const provider = new CombinedAutocompleteProvider(registry.toSlashCommands(), process.cwd());

	it("shows dimmed argumentHint on the :plan command row", async () => {
		const suggestions = await provider.getSuggestions([":p"], 0, 2, {
			signal: AbortSignal.timeout(1000),
		});
		const plan = suggestions?.items.find((i) => i.value === "plan" || i.label === "plan");
		expect(plan?.description).toMatch(/list/);
		expect(plan?.description).toMatch(/Workspace plans/);
	});

	it("lists :plan subcommands after a space", async () => {
		const suggestions = await provider.getSuggestions([":plan "], 0, 6, {
			signal: AbortSignal.timeout(1000),
		});
		expect(suggestions?.items.map((i) => i.value)).toEqual(
			expect.arrayContaining(["list", "focus", "backlog", "close"]),
		);
		expect(suggestions?.items.find((i) => i.value === "focus")?.description).toBe("Focus a plan by id");
	});

	it("applies a subcommand completion into the editor line", () => {
		const result = provider.applyCompletion([":plan "], 0, 6, { value: "list", label: "list" }, "");
		expect(result.lines[0]).toBe(":plan list");
	});
});
