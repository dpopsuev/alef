import { setDefaultResultOrder } from "node:dns";
import { connect } from "node:net";
import { traceEvent } from "@dpopsuev/alef-kernel/log";

const PROBE_TIMEOUT_MS = 400;
// Google Public DNS — a stable, always-on IPv6 literal. Connecting directly to
// an IP (not a hostname) isolates IPv6 *routing* health from DNS resolver health.
const PROBE_HOST = "2001:4860:4860::8888";
const PROBE_PORT = 443;

/** Probe target overrides — exposed for tests to point at a local server instead of the real internet. */
export interface Ipv6ProbeOptions {
	host?: string;
	port?: number;
	timeoutMs?: number;
}

/**
 * Probe IPv6 reachability once at boot and prefer IPv4 for all subsequent DNS
 * lookups if it's broken.
 *
 * Corporate VPNs commonly advertise a route to IPv6-only addresses that then
 * silently blackholes traffic (no RST, no ICMP unreachable) instead of
 * cleanly rejecting it. When that happens, any Node HTTP client that resolves
 * a AAAA record first — including google-auth-library's OAuth token requests
 * for Vertex-routed models — can hang until it times out. `dns.lookup()`
 * (used by default by `net.connect`/`http`/`https`) honors
 * `setDefaultResultOrder`, so this fixes every default HTTP client in the
 * process at once, not just one provider.
 *
 * This intentionally does NOT force IPv4 unconditionally: on networks where
 * IPv6 actually works, forcing IPv4 would only add latency for no benefit.
 */
export async function preferIpv4IfUnreachable(options: Ipv6ProbeOptions = {}): Promise<void> {
	const reachable = await probeIpv6(options);
	if (reachable) return;
	setDefaultResultOrder("ipv4first");
	traceEvent("boot:network", { ipv6: "unreachable", action: "prefer-ipv4" });
}

/** Attempt a short-timeout TCP connect to a well-known IPv6 literal. */
function probeIpv6({
	host = PROBE_HOST,
	port = PROBE_PORT,
	timeoutMs = PROBE_TIMEOUT_MS,
}: Ipv6ProbeOptions): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const socket = connect({ host, port, family: 6, timeout: timeoutMs });
		const finish = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(ok);
		};
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
	});
}
