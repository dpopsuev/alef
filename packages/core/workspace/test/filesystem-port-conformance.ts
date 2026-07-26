import { describe, expect, it } from "vitest";
import { StaleWorkspaceWrite, type WorkspaceFilesystemPort } from "../src/filesystem-port.js";

export type FilesystemPortFactory = () => WorkspaceFilesystemPort | Promise<WorkspaceFilesystemPort>;

/** Shared conformance suite every WorkspaceFilesystemPort implementation must satisfy. */
export function filesystemPortConformanceSuite(createPort: FilesystemPortFactory): void {
	describe("WorkspaceFilesystemPort conformance", () => {
		it("reports version 1", async () => {
			const port = await createPort();
			expect(port.version).toBe(1);
		});

		it("a path that was never written does not exist", async () => {
			const port = await createPort();
			const entry = await port.readEntry("never-written.txt");
			expect(entry.exists).toBe(false);
		});

		it("writing with expectedHash null creates a new entry", async () => {
			const port = await createPort();
			const result = await port.writeEntry("new.txt", null, "hello");
			expect(result.previousHash).toBeNull();
			expect(result.newHash).toMatch(/^[0-9a-f]{64}$/);
			const entry = await port.readEntry("new.txt");
			expect(entry).toEqual({ exists: true, content: "hello" });
		});

		it("writing with expectedHash null a second time rejects -- the entry already exists", async () => {
			const port = await createPort();
			await port.writeEntry("dup.txt", null, "first");
			await expect(port.writeEntry("dup.txt", null, "second")).rejects.toThrow(StaleWorkspaceWrite);
		});

		it("writing with the correct observed hash overwrites and returns the new hash", async () => {
			const port = await createPort();
			const first = await port.writeEntry("overwrite.txt", null, "v1");
			const second = await port.writeEntry("overwrite.txt", first.newHash, "v2");
			expect(second.previousHash).toBe(first.newHash);
			const entry = await port.readEntry("overwrite.txt");
			expect(entry).toEqual({ exists: true, content: "v2" });
		});

		it("writing with a stale expectedHash rejects and leaves the entry unchanged", async () => {
			const port = await createPort();
			await port.writeEntry("guarded.txt", null, "original");
			await expect(port.writeEntry("guarded.txt", "0".repeat(64), "clobber")).rejects.toThrow(StaleWorkspaceWrite);
			const entry = await port.readEntry("guarded.txt");
			expect(entry).toEqual({ exists: true, content: "original" });
		});
	});
}
