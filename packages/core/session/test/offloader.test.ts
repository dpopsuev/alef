import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	checkAndOffloadContent,
	formatOffloadedReference,
	cleanupToolResults,
	getOffloadDir,
} from "../src/context/offloader.js";

describe("Tool Result Offloader", () => {
	const testSessionId = "test-session-12345";
	const offloadDir = getOffloadDir(testSessionId);

	afterEach(async () => {
		// Clean up test files
		await cleanupToolResults(testSessionId);
	});

	describe("checkAndOffloadContent", () => {
		it("should not offload small content", async () => {
			const content = "Small content";
			const result = await checkAndOffloadContent(content, testSessionId, "tool-call-1");

			expect(result.offloaded).toBe(false);
			if (!result.offloaded) {
				expect(result.content).toBe(content);
			}
		});

		it("should offload large content to filesystem", async () => {
			const content = "x".repeat(3000); // Exceeds default threshold of 2000
			const toolCallId = "tool-call-large";

			const result = await checkAndOffloadContent(content, testSessionId, toolCallId);

			expect(result.offloaded).toBe(true);
			if (result.offloaded) {
				expect(result.path).toContain(testSessionId);
				expect(result.path).toContain(toolCallId);
				expect(result.originalSize).toBe(3000);
				expect(result.threshold).toBe(2000);

				// Verify file was written
				const fileContent = await readFile(result.path, "utf-8");
				expect(fileContent).toBe(content);
			}
		});

		it("should create offload directory if missing", async () => {
			// Ensure directory doesn't exist
			await cleanupToolResults(testSessionId);

			const content = "x".repeat(3000);
			const result = await checkAndOffloadContent(content, testSessionId, "tool-call-2");

			expect(result.offloaded).toBe(true);
		});
	});

	describe("formatOffloadedReference", () => {
		it("should format reference message correctly", () => {
			const offloadResult = {
				offloaded: true as const,
				path: "/path/to/offloaded/file.txt",
				originalSize: 5000,
				threshold: 2000,
			};

			const formatted = formatOffloadedReference(offloadResult);

			expect(formatted).toContain("Large result offloaded to");
			expect(formatted).toContain("/path/to/offloaded/file.txt");
			expect(formatted).toContain("Original size: 5000");
			expect(formatted).toContain("threshold: 2000");
			expect(formatted).toContain("fs.read");
		});
	});

	describe("cleanupToolResults", () => {
		it("should remove entire offload directory", async () => {
			// Create some offloaded files
			const content = "x".repeat(3000);
			await checkAndOffloadContent(content, testSessionId, "tool-1");
			await checkAndOffloadContent(content, testSessionId, "tool-2");

			// Cleanup
			await cleanupToolResults(testSessionId);

			// Verify directory is gone (attempting to read should fail or show empty)
			await expect(async () => {
				await readFile(join(offloadDir, "tool-1.txt"), "utf-8");
			}).rejects.toThrow();
		});

		it("should not error if directory doesn't exist", async () => {
			// Should not throw even if directory doesn't exist
			await expect(cleanupToolResults("nonexistent-session")).resolves.not.toThrow();
		});
	});

	describe("getOffloadDir", () => {
		it("should return path under XDG_DATA_HOME", () => {
			const dir = getOffloadDir(testSessionId);
			const xdgHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");

			expect(dir).toContain("alef");
			expect(dir).toContain("tool-results");
			expect(dir).toContain(testSessionId);
			expect(dir).toContain(xdgHome);
		});
	});
});
