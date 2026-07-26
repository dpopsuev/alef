import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alefStateDir } from "@dpopsuev/alef-kernel/xdg";

const CREDENTIAL_DIRECTORY_MODE = 0o700;
const CREDENTIAL_FILE_MODE = 0o600;

/** Keep daemon credentials separate from durable data and diagnostics. */
function credentialDirectory(): string {
	return join(alefStateDir(), "daemon-credentials");
}

/** Derive an opaque path so external session identifiers never become path segments. */
export function daemonCredentialPath(sessionId: string): string {
	const name = createHash("sha256").update(sessionId).digest("hex");
	return join(credentialDirectory(), name);
}

/** Atomically hand a daemon credential to same-user attach clients. */
export function writeDaemonCredential(sessionId: string, token: string): void {
	if (sessionId.length === 0 || token.length === 0) throw new Error("Daemon credential requires session and token");
	const directory = credentialDirectory();
	mkdirSync(directory, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
	chmodSync(directory, CREDENTIAL_DIRECTORY_MODE);

	const target = daemonCredentialPath(sessionId);
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, token, { encoding: "utf8", flag: "wx", mode: CREDENTIAL_FILE_MODE });
		renameSync(temporary, target);
		chmodSync(target, CREDENTIAL_FILE_MODE);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Read the owner-only credential required for a local daemon attachment. */
export function readDaemonCredential(sessionId: string): string | undefined {
	try {
		const token = readFileSync(daemonCredentialPath(sessionId), "utf8").trim();
		return token.length > 0 ? token : undefined;
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		throw error;
	}
}

/** Remove a credential when its daemon is no longer attachable. */
export function removeDaemonCredential(sessionId: string): void {
	rmSync(daemonCredentialPath(sessionId), { force: true });
}

/** Narrow filesystem errors without asserting an unvalidated shape. */
function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
