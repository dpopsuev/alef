/**
 * ActorRouteTable — maps @address → delivery function.
 *
 * Maintained in createLocalSession. Subagents register when they start
 * and unregister when they complete. The TUI uses this table to route
 * @mention messages to the right agent.
 */

/**
 *
 */
export type ActorRoute = (message: string, timeoutMs: number) => Promise<void>;

/**
 *
 */
function normalizeAddress(address: string): string {
	return address.trim().replace(/^@+/, "");
}

/**
 *
 */
export class ActorRouteTable {
	private readonly _routes = new Map<string, ActorRoute>();
	private _humanAddress: string | null = null;

	register(address: string, route: ActorRoute): void {
		this._routes.set(normalizeAddress(address), route);
	}

	unregister(address: string): void {
		this._routes.delete(normalizeAddress(address));
	}

	resolve(address: string): ActorRoute | undefined {
		return this._routes.get(normalizeAddress(address));
	}

	addresses(): string[] {
		return [...this._routes.keys()];
	}

	setHumanAddress(address: string): void {
		this._humanAddress = normalizeAddress(address);
	}

	isHumanAddress(address: string): boolean {
		return this._humanAddress === normalizeAddress(address);
	}
}

/**
 * Parse "@address message" from user input.
 *
 * Returns { address, message } when the input starts with @word followed
 * by at least one whitespace and message text.
 * Returns null for plain text, bare @address (no message), or no @ prefix.
 *
 * Supports short ("crimson") and FQDN ("crimson.amber.a9a10682.4b6c8fcf") addresses.
 */
export function parseAtAddress(text: string): { address: string; message: string } | null {
	const m = /^@([\w.]+)\s+([\s\S]+)$/.exec(text.trim());
	if (!m) return null;
	return { address: m[1]!, message: m[2]!.trim() };
}
