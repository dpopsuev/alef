import type { AdapterLogger } from "@dpopsuev/alef-kernel/adapter";
import { BusFixture } from "@dpopsuev/alef-testkit/adapter";
import { describe, expect, it, vi } from "vitest";
import { createShellAdapter, PtyPool, ShellTimeoutError } from "../src/adapter.js";

function mockLogger(): AdapterLogger {
	const logger: AdapterLogger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: vi.fn(() => logger),
	};
	return logger;
}

describe("shell.exec lifecycle logs", { tags: ["unit"] }, () => {
	it("emits start and done info logs", async () => {
		const logger = mockLogger();
		const f = new BusFixture();
		f.mount(createShellAdapter({ cwd: process.cwd(), logger }));
		const final = await f.callStreaming("shell.exec", { command: "echo lifecycle" });
		expect(final.isError).toBe(false);
		expect(logger.info).toHaveBeenCalledWith(
			expect.objectContaining({ command: "echo lifecycle" }),
			"shell.exec start",
		);
		expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 0 }), "shell.exec done");
		f.dispose();
	});

	it("emits warn log on non-zero exit", async () => {
		const logger = mockLogger();
		const f = new BusFixture();
		f.mount(createShellAdapter({ cwd: process.cwd(), logger }));
		const final = await f.callStreaming("shell.exec", { command: "exit 7" });
		expect(final.isError).toBe(true);
		expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 7 }), "shell.exec non-zero exit");
		f.dispose();
	});
});

describe("PtyPool eviction", { tags: ["unit"] }, () => {
	it("evict is a no-op when cwd is unknown", async () => {
		const pool = new PtyPool();
		expect(pool.size).toBe(0);
		await pool.evict("/no-such-cwd");
		expect(pool.size).toBe(0);
		await pool.dispose();
	});

	it("timeout path yields ShellTimeoutError shape", () => {
		const err = new ShellTimeoutError(1000, -1, "partial");
		expect(err.timedOut).toBe(true);
		expect(err.exitCode).toBe(-1);
		expect(err.output).toBe("partial");
	});
});
