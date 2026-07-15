import { describe, expect, it } from "vitest";
import { setupSupervisorIpc } from "../src/boot/supervisor-ipc.js";
import { parseUpdateArgs } from "../src/client/commands/update-service.js";

describe("parseUpdateArgs", { tags: ["unit"] }, () => {
	it("defaults to apply mode without force", () => {
		expect(parseUpdateArgs([])).toEqual({ force: false, checkOnly: false });
	});

	it("recognizes --force and --check", () => {
		expect(parseUpdateArgs(["--force", "--check"])).toEqual({ force: true, checkOnly: true });
	});
});

describe("setupSupervisorIpc", { tags: ["unit"] }, () => {
	it("no-ops without ALEF_SUPERVISOR", () => {
		const prev = process.env.ALEF_SUPERVISOR;
		delete process.env.ALEF_SUPERVISOR;
		setupSupervisorIpc();
		if (prev === undefined) delete process.env.ALEF_SUPERVISOR;
		else process.env.ALEF_SUPERVISOR = prev;
	});
});
