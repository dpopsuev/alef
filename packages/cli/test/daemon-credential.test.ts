import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	daemonCredentialPath,
	readDaemonCredential,
	removeDaemonCredential,
	writeDaemonCredential,
} from "../src/boot/daemon-credential.js";

const originalStateHome = process.env.XDG_STATE_HOME;
const temporaryDirectories: string[] = [];

afterEach(() => {
	if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = originalStateHome;
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("daemon credential handoff", { tags: ["unit"] }, () => {
	it("round-trips through owner-only state storage", () => {
		const stateHome = mkdtempSync(join(tmpdir(), "alef-daemon-credential-"));
		temporaryDirectories.push(stateHome);
		process.env.XDG_STATE_HOME = stateHome;

		writeDaemonCredential("session-1", "secret-token");

		const credentialPath = daemonCredentialPath("session-1");
		expect(readFileSync(credentialPath, "utf8")).toBe("secret-token");
		expect(readDaemonCredential("session-1")).toBe("secret-token");
		expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
		expect(statSync(join(stateHome, "alef", "daemon-credentials")).mode & 0o777).toBe(0o700);

		removeDaemonCredential("session-1");
		expect(readDaemonCredential("session-1")).toBeUndefined();
	});

	it("does not use the session id as a filesystem path", () => {
		const stateHome = mkdtempSync(join(tmpdir(), "alef-daemon-credential-"));
		temporaryDirectories.push(stateHome);
		process.env.XDG_STATE_HOME = stateHome;

		const credentialPath = daemonCredentialPath("../../outside");

		expect(credentialPath.startsWith(join(stateHome, "alef", "daemon-credentials"))).toBe(true);
		expect(credentialPath).not.toContain("outside");
	});
});
