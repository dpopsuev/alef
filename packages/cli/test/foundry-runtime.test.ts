import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliFoundryRuntime } from "../src/boot/foundry-runtime.js";

describe("CLI Foundry runtime", { tags: ["unit"] }, () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function makeTmp(): string {
		const dir = mkdtempSync(join(tmpdir(), "alef-cli-foundry-"));
		tempDirs.push(dir);
		return dir;
	}

	it("boots base storage through the bootstrap facade", async () => {
		const cwd = makeTmp();
		const runtime = createCliFoundryRuntime({ cwd });

		const storage = await runtime.getStorage();

		expect(storage.sessions).toBeDefined();
		expect(storage.daemonRegistry).toBeTypeOf("function");

		await runtime.stop();
	});

	it("registers bootloader through the bootstrap facade", async () => {
		const cwd = makeTmp();
		const swap = vi.fn(async () => {});
		const runtime = createCliFoundryRuntime({ cwd });

		runtime.registerBootloader({
			buildCommand: "true",
			swap,
			sessionServiceName: "session",
			cwd,
		});

		await runtime.start();

		expect(runtime.get("bootloader")).toBeDefined();

		await runtime.stop();
	});
});
