import { describe, expect, it } from "vitest";
import { PermissionGuard } from "../src/permissions.js";
import type { FilesystemPermission } from "@dpopsuev/alef-kernel/adapter";

describe("PermissionGuard", () => {
	describe("allow rules", () => {
		it("allows matching paths for specified operations", () => {
			const rules: FilesystemPermission[] = [
				{
					operations: ["read"],
					paths: ["/home/user/projects/**/*.ts"],
					mode: "allow",
				},
			];
			const guard = new PermissionGuard(rules);

			const result = guard.check("read", "/home/user/projects/src/index.ts");
			expect(result.allowed).toBe(true);
			expect(result.matchedRule).toBeDefined();
		});

		it("denies operations not in the rule", () => {
			const rules: FilesystemPermission[] = [
				{
					operations: ["read"],
					paths: ["/home/user/projects/**/*.ts"],
					mode: "allow",
				},
			];
			const guard = new PermissionGuard(rules);

			const result = guard.check("write", "/home/user/projects/src/index.ts");
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("No permission rule matched");
		});

		it("denies paths that don't match the pattern", () => {
			const rules: FilesystemPermission[] = [
				{
					operations: ["read"],
					paths: ["/home/user/projects/**/*.ts"],
					mode: "allow",
				},
			];
			const guard = new PermissionGuard(rules);

			const result = guard.check("read", "/etc/passwd");
			expect(result.allowed).toBe(false);
		});
	});

	describe("deny rules", () => {
		it("denies matching paths for specified operations", () => {
			const rules: FilesystemPermission[] = [
				{
					operations: ["write", "delete"],
					paths: ["/etc/**"],
					mode: "deny",
				},
			];
			const guard = new PermissionGuard(rules);

			const result = guard.check("write", "/etc/passwd");
			expect(result.allowed).toBe(false);
			expect(result.matchedRule).toBeDefined();
			expect(result.reason).toContain("denied");
		});

		it("allows operations not in the deny rule (if another rule allows)", () => {
			const rules: FilesystemPermission[] = [
				{
					operations: ["write", "delete"],
					paths: ["/etc/**"],
					mode: "deny",
				},
				{
					operations: ["read"],
					paths: ["/etc/**"],
					mode: "allow",
				},
			];
			const guard = new PermissionGuard(rules);

			// First matching rule (deny) doesn't apply to read
			const result = guard.check("read", "/etc/passwd");
			expect(result.allowed).toBe(true);
		});
	});

	describe("first-match-wins", () => {
		it("uses the first matching rule", () => {
			const rules: FilesystemPermission[] = [
				{
					operations: ["write"],
					paths: ["/home/user/secret/**"],
					mode: "deny",
				},
				{
					operations: ["read", "write"],
					paths: ["/home/user/**"],
					mode: "allow",
				},
			];
			const guard = new PermissionGuard(rules);

			// First rule denies write to /home/user/secret/
			const secretResult = guard.check("write", "/home/user/secret/key.txt");
			expect(secretResult.allowed).toBe(false);

			// Second rule allows write to other paths under /home/user/
			const otherResult = guard.check("write", "/home/user/projects/file.txt");
			expect(otherResult.allowed).toBe(true);
		});

		it("skips rules that don't apply to the operation", () => {
			const rules: FilesystemPermission[] = [
				{
					operations: ["read"],
					paths: ["/home/user/**"],
					mode: "deny",
				},
				{
					operations: ["write"],
					paths: ["/home/user/**"],
					mode: "allow",
				},
			];
			const guard = new PermissionGuard(rules);

			// First rule only applies to read, not write
			const result = guard.check("write", "/home/user/file.txt");
			expect(result.allowed).toBe(true);
			expect(result.matchedRule?.operations).toContain("write");
		});
	});

	describe("glob patterns", () => {
		it("matches dotfiles when dot:true", () => {
			const rules: FilesystemPermission[] = [
				{
					operations: ["read"],
					paths: ["/home/user/**"],
					mode: "allow",
				},
			];
			const guard = new PermissionGuard(rules);

			const result = guard.check("read", "/home/user/.config/settings.json");
			expect(result.allowed).toBe(true);
		});

		it("supports multiple patterns in one rule", () => {
			const rules: FilesystemPermission[] = [
				{
					operations: ["read"],
					paths: ["**/*.ts", "**/*.js", "**/*.json"],
					mode: "allow",
				},
			];
			const guard = new PermissionGuard(rules);

			expect(guard.check("read", "/project/src/index.ts").allowed).toBe(true);
			expect(guard.check("read", "/project/src/util.js").allowed).toBe(true);
			expect(guard.check("read", "/project/package.json").allowed).toBe(true);
			expect(guard.check("read", "/project/README.md").allowed).toBe(false);
		});
	});

	describe("default deny", () => {
		it("denies access when no rules match", () => {
			const rules: FilesystemPermission[] = [
				{
					operations: ["read"],
					paths: ["/allowed/**"],
					mode: "allow",
				},
			];
			const guard = new PermissionGuard(rules);

			const result = guard.check("read", "/denied/file.txt");
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("No permission rule matched");
		});

		it("denies when rules list is empty", () => {
			const guard = new PermissionGuard([]);

			const result = guard.check("read", "/any/path");
			expect(result.allowed).toBe(false);
		});
	});

	describe("assert", () => {
		it("throws when permission is denied", () => {
			const rules: FilesystemPermission[] = [
				{
					operations: ["write"],
					paths: ["/etc/**"],
					mode: "deny",
				},
			];
			const guard = new PermissionGuard(rules);

			expect(() => guard.assert("write", "/etc/passwd")).toThrow("Permission denied");
		});

		it("does not throw when permission is allowed", () => {
			const rules: FilesystemPermission[] = [
				{
					operations: ["write"],
					paths: ["/home/user/**"],
					mode: "allow",
				},
			];
			const guard = new PermissionGuard(rules);

			expect(() => guard.assert("write", "/home/user/file.txt")).not.toThrow();
		});
	});
});
