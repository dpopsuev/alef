import { describe, expect, it } from "vitest";
import { setupSupervisorIpc } from "../src/boot/supervisor-ipc.js";
import { parseUpdateArgs } from "../src/client/commands/update-service.js";

describe("parseUpdateArgs", { tags: ["unit"] }, () => {
	it("defaults to local build without pull or force", () => {
		expect(parseUpdateArgs([])).toEqual({ pull: false, force: false, checkOnly: false });
	});

	it("recognizes --pull, --force, and --check", () => {
		expect(parseUpdateArgs(["--pull", "--force", "--check"])).toEqual({ pull: true, force: true, checkOnly: true });
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
