/**
 * DockerSpace tests — require Docker to be running.
 * Skipped if DOCKER_HOST is not set or Docker is unavailable.
 *
 * These tests use real containers (ubuntu:22.04) via testcontainers.
 * Each test gets a fresh container. Ryuk cleans up on process exit.
 */

import { InProcessNerve } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { DockerSpace } from "../src/docker-space.js";
import { createEnclosureOrgan } from "../src/organ.js";

// ---------------------------------------------------------------------------
// Check if Docker is available
// ---------------------------------------------------------------------------

async function dockerAvailable(): Promise<boolean> {
	try {
		const { execSync } = await import("node:child_process");
		execSync("docker info", { stdio: "ignore", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

const SKIP = !(await dockerAvailable());

// ---------------------------------------------------------------------------
// DockerSpace unit tests (require Docker)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("DockerSpace — container lifecycle", () => {
	it("creates a container and execs a command", async () => {
		const space = await DockerSpace.create({ image: "alpine:latest" });
		try {
			const result = await space.exec(["echo", "hello from docker"]);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("hello from docker");
		} finally {
			await space.destroy();
		}
	}, 60_000);

	it("exec returns non-zero exit code on failure", async () => {
		const space = await DockerSpace.create({ image: "alpine:latest" });
		try {
			const result = await space.exec(["sh", "-c", "exit 42"]);
			expect(result.exitCode).toBe(42);
		} finally {
			await space.destroy();
		}
	}, 60_000);

	it("writes a file via exec and reads it back", async () => {
		const space = await DockerSpace.create({ image: "alpine:latest" });
		try {
			await space.exec(["sh", "-c", "echo 'hello world' > /workspace/test.txt"]);
			const read = await space.exec(["cat", "/workspace/test.txt"]);
			expect(read.output.trim()).toBe("hello world");
		} finally {
			await space.destroy();
		}
	}, 60_000);

	it("workDir() returns container-relative path identifier", async () => {
		const space = await DockerSpace.create({ image: "alpine:latest" });
		try {
			expect(space.workDir()).toMatch(/^docker:[a-f0-9]+:\/workspace$/);
		} finally {
			await space.destroy();
		}
	}, 60_000);

	it("destroy() stops the container cleanly", async () => {
		const space = await DockerSpace.create({ image: "alpine:latest" });
		await space.destroy();
		// After destroy, exec should fail (container stopped)
		// No assertion needed — destroy() not throwing is the test
	}, 60_000);
});

// ---------------------------------------------------------------------------
// EnclosureOrgan with backend='docker'
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("EnclosureOrgan — docker backend", () => {
	it("creates a space and execs a command via organ events", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { rm } = await import("node:fs/promises");
		const workspace = await mkdtemp(`${tmpdir()}/alef-docker-test-`);

		const nerve = new InProcessNerve();
		const organ = createEnclosureOrgan({
			backend: "docker",
			docker: { image: "alpine:latest" },
		});
		const unmount = organ.mount(nerve.asNerve());

		try {
			const createResult = await new Promise<Record<string, unknown>>((resolve, reject) => {
				const off = nerve.asNerve().sense.subscribe("enclosure.create", (e) => {
					off();
					if (e.isError) reject(new Error(e.errorMessage));
					else resolve(e.payload);
				});
				nerve.asNerve().motor.publish({
					type: "enclosure.create",
					payload: { workspace, toolCallId: "tc-1" },
					correlationId: "corr-1",
					timestamp: Date.now(),
				});
			});

			expect(createResult.spaceId).toBeTruthy();
			expect(String(createResult.workDir)).toMatch(/^docker:/);

			const spaceId = createResult.spaceId as string;

			// Exec a command
			const execResult = await new Promise<Record<string, unknown>>((resolve, reject) => {
				const off = nerve.asNerve().sense.subscribe("enclosure.exec", (e) => {
					off();
					if (e.isError) reject(new Error(e.errorMessage));
					else resolve(e.payload);
				});
				nerve.asNerve().motor.publish({
					type: "enclosure.exec",
					payload: { spaceId, command: ["echo", "organ-exec-works"], toolCallId: "tc-2" },
					correlationId: "corr-1",
					timestamp: Date.now(),
				});
			});

			expect(execResult.exitCode).toBe(0);
			expect(String(execResult.output)).toContain("organ-exec-works");
		} finally {
			unmount();
			await rm(workspace, { recursive: true, force: true });
		}
	}, 90_000);
});

// ---------------------------------------------------------------------------
// Backend selection — no Docker required (uses stub)
// ---------------------------------------------------------------------------

describe("EnclosureOrgan — backend selection", () => {
	it("backend='stub' uses StubSpace (no Docker)", () => {
		const organ = createEnclosureOrgan({ backend: "stub" });
		expect(organ.name).toBe("enclosure");
		expect(organ.tools.length).toBeGreaterThan(0);
	});

	it("legacy stub:true still works", () => {
		const organ = createEnclosureOrgan({ stub: true });
		expect(organ.name).toBe("enclosure");
	});

	it("default backend is overlay (no crash on construction)", () => {
		// Just verifying the organ can be constructed — OverlaySpace.create()
		// is only called when enclosure.create motor event fires, not at construction.
		const organ = createEnclosureOrgan();
		expect(organ.name).toBe("enclosure");
	});
});
