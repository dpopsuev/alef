import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createE2eSession, HAVE_REAL_LLM } from "@dpopsuev/alef-testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFsOrgan } from "../src/adapter.js";

describe.skipIf(!HAVE_REAL_LLM)("organ-fs — real LLM E2E", { tags: ["real-llm"] }, () => {
	let tempDir: string;
	let secretUuid: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "alef-adapter-fs-e2e-"));
		secretUuid = randomUUID();
		writeFileSync(join(tempDir, "secret.txt"), `The secret UUID is: ${secretUuid}`);
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("LLM reads an unguessable file using fs.read", async () => {
		const session = createE2eSession([createFsOrgan({ cwd: tempDir })]);
		const { reply, events } = await session.send(
			"Read the file secret.txt in the current directory and tell me the secret UUID. You MUST use the fs.read tool.",
		);

		expect(reply).toContain(secretUuid);
		expect(events.some((e) => e.type === "llm.tool-start" && String(e.payload.name ?? "").includes("fs.read"))).toBe(
			true,
		);

		session.dispose();
	}, 60_000);
});
