/**
 * Serialize an error to a human-readable string, traversing the cause chain.
 * Gaxios/node-fetch errors store the root cause in `.error` (FetchError) or
 * `.cause`, and the syscall error code in `.code`. Without this traversal,
 * messages like "request to URL failed, reason: " appear with an empty reason.
 *
 * Node's happy-eyeballs (autoSelectFamily) connect failures surface as an
 * AggregateError whose own `.message` is empty — the actionable detail
 * (per-address code/syscall/family) lives in `.errors[]`, which a plain
 * `.error`/`.cause` walk never sees. Without unwrapping it, network RCA
 * (e.g. distinguishing a DNS timeout from an unreachable IPv6 route) is
 * impossible from the stored error string alone.
 *
 * Shared across providers rather than duplicated: any provider whose
 * underlying HTTP client can hit a happy-eyeballs failure (which is any of
 * them — Node core, undici, and node-fetch all support autoSelectFamily)
 * benefits from the same cause-chain and AggregateError unwrapping.
 */
export function serializeError(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	const seen = new Set<unknown>();
	while (current != null && !seen.has(current)) {
		seen.add(current);
		if (current instanceof AggregateError) {
			if (current.message) parts.push(current.message);
			const sub = current.errors.map(describeSystemError).filter(Boolean);
			if (sub.length > 0) parts.push(sub.join("; "));
			current = (current as { cause?: unknown }).cause;
			continue;
		}
		if (current instanceof Error) {
			if (current.message) parts.push(current.message);
			// Append syscall detail if not already in the message (e.g. ECONNREFUSED)
			const detail = describeSystemError(current);
			if (detail && !current.message.includes(detail)) parts.push(detail);
			// gaxios FetchError stores the inner system error in `.error`
			const inner =
				(current as { error?: unknown; cause?: unknown }).error ?? (current as { cause?: unknown }).cause;
			current = inner;
		} else {
			parts.push(typeof current === "string" ? current : JSON.stringify(current));
			break;
		}
	}
	return parts.length > 0 ? parts.join(" — ") : JSON.stringify(error);
}

/** Format a Node system-error's diagnostic fields (code/syscall/address/family) for network RCA. */
function describeSystemError(error: unknown): string {
	if (!(error instanceof Error)) {
		if (error == null) return "";
		return typeof error === "string" ? error : JSON.stringify(error);
	}
	const e = error as NodeJS.ErrnoException & { family?: string | number; address?: string; port?: number };
	const bits: string[] = [];
	if (e.code) bits.push(e.code);
	if (e.syscall) bits.push(e.syscall);
	if (e.address) bits.push(e.family !== undefined ? `${e.address} (family ${e.family})` : e.address);
	if (e.port !== undefined) bits.push(`port ${e.port}`);
	return bits.length > 0 ? bits.join(" ") : "";
}
