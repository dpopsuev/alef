import * as os from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Replace non-breaking and unusual Unicode whitespace characters with standard ASCII spaces. */
function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

/** Strip a leading '@' character from a file path (common copy-paste artifact). */
function normalizeAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

/** Normalize unicode spaces, strip '@' prefix, and expand tilde to the user's home directory. */
function expandPath(filePath: string): string {
	const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
	if (normalized === "~") {
		return os.homedir();
	}
	if (normalized.startsWith("~/")) {
		return os.homedir() + normalized.slice(1);
	}
	return normalized;
}

/** Resolve a file path (with tilde and unicode-space normalization) against a working directory. */
export function resolveToCwd(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	if (isAbsolute(expanded)) {
		return expanded;
	}
	return resolvePath(cwd, expanded);
}
