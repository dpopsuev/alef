const OSC_QUERY_TIMEOUT_MS = 50;
const PALETTE_QUERY_TIMEOUT_MS = 200;

const ESC = "\x1b";
const BEL = "\x07";
const OSC_11_QUERY = `${ESC}]11;?${BEL}`;
const osc4Query = (slot: number) => `${ESC}]4;${slot};?${BEL}`;

import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// OSC 11 background color query
// ---------------------------------------------------------------------------

/** Parsed background color from an OSC 11 terminal response (channels normalized to 0-1). */
export interface BgColor {
	r: number; // 0–1
	g: number;
	b: number;
	a: number; // 0–1
}

/** Parse an OSC 11 terminal response into normalized RGBA components. */
export function parseOSC11Response(response: string): BgColor | null {
	// Terminals respond to \x1b]11;?\x07 with:
	//   \x1b]11;rgb:RRRR/GGGG/BBBB\x07       (16-bit channels)
	//   \x1b]11;rgba:RRRR/GGGG/BBBB/AAAA\x07  (with alpha)
	const m = response.match(/\]1[01];rgba?:([\da-fA-F]+)\/([\da-fA-F]+)\/([\da-fA-F]+)(?:\/([\da-fA-F]+))?/);
	if (!m) return null;
	const scale = m[1].length <= COLOR_CHANNEL_8BIT_LENGTH ? COLOR_CHANNEL_8BIT : COLOR_CHANNEL_16BIT;
	return {
		r: parseInt(m[1], 16) / scale,
		g: parseInt(m[2], 16) / scale,
		b: parseInt(m[3], 16) / scale,
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- m[4] is from optional regex group (?:\/…)?
		a: m[4] !== undefined ? parseInt(m[4], 16) / scale : 1,
	};
}

const OPACITY_THRESHOLD = 0.8;
const LUMINANCE_DARK_THRESHOLD = 0.5;
const COLORFGBG_DARK_THRESHOLD = 8;

const COLOR_CHANNEL_8BIT = 255;
const COLOR_CHANNEL_16BIT = 65535;
const COLOR_CHANNEL_8BIT_LENGTH = 2;

const SRGB_LINEAR_THRESHOLD = 0.04045;
const SRGB_LINEAR_DIVISOR = 12.92;
const SRGB_GAMMA_OFFSET = 0.055;
const SRGB_GAMMA_BASE = 1.055;
const SRGB_GAMMA_EXPONENT = 2.4;
const LUMINANCE_R = 0.2126;
const LUMINANCE_G = 0.7152;
const LUMINANCE_B = 0.0722;

/** Compute the WCAG relative luminance of an RGB color. */
export function relativeLuminance(c: Pick<BgColor, "r" | "g" | "b">): number {
	const linear = (x: number): number =>
		x <= SRGB_LINEAR_THRESHOLD
			? x / SRGB_LINEAR_DIVISOR
			: ((x + SRGB_GAMMA_OFFSET) / SRGB_GAMMA_BASE) ** SRGB_GAMMA_EXPONENT;
	return LUMINANCE_R * linear(c.r) + LUMINANCE_G * linear(c.g) + LUMINANCE_B * linear(c.b);
}

/** Send an OSC 11 escape sequence and parse the terminal's background color response. */
async function queryOSC11(timeoutMs = OSC_QUERY_TIMEOUT_MS): Promise<BgColor | null> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return null;

	// Multiplexers intercept OSC and responses are unreliable — skip.
	const term = process.env.TERM ?? "";
	if (term.startsWith("tmux") || term.startsWith("screen")) return null;

	return new Promise((resolve) => {
		const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
		const wasRaw = stdin.isRaw;
		let settled = false;

		const finish = (result: BgColor | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stdin.off("data", onData);
			try {
				if (!wasRaw) stdin.setRawMode(false);
			} catch {
				// ignore — stdin may have been closed
			}
			resolve(result);
		};

		const timer = setTimeout(() => finish(null), timeoutMs);

		let buf = "";
		const onData = (chunk: Buffer): void => {
			buf += chunk.toString();
			const parsed = parseOSC11Response(buf);
			if (parsed) finish(parsed);
		};

		try {
			stdin.setRawMode(true);
			stdin.resume();
			stdin.on("data", onData);
			process.stdout.write(OSC_11_QUERY);
		} catch {
			finish(null);
		}
	});
}

// ---------------------------------------------------------------------------
// COLORFGBG heuristic (rxvt, konsole, some others)
// ---------------------------------------------------------------------------

/** Infer dark background from the COLORFGBG env var (rxvt/konsole convention). */
function detectFromColorfgbg(): boolean | null {
	const val = process.env.COLORFGBG ?? "";
	if (!val) return null;
	const parts = val.split(";");
	const bg = parseInt(parts[parts.length - 1] ?? "", 10);
	if (Number.isNaN(bg)) return null;
	return bg < COLORFGBG_DARK_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine whether the terminal background is dark.
 *
 * Priority:
 *   1. opacity < OPACITY_THRESHOLD → dark (high transparency, desktop showing through)
 *   2. OSC 11 query → parse luminance + alpha from actual terminal bg
 *   3. COLORFGBG env var → rxvt/konsole convention
 *   4. Default: dark
 */
export async function detectDark(opacity?: number): Promise<boolean> {
	if (opacity !== undefined && opacity < OPACITY_THRESHOLD) return true;

	const osc = await queryOSC11();
	if (osc) {
		if (osc.a < OPACITY_THRESHOLD) return true;
		return relativeLuminance(osc) < LUMINANCE_DARK_THRESHOLD;
	}

	const fromEnv = detectFromColorfgbg();
	if (fromEnv !== null) return fromEnv;

	return true;
}

// ---------------------------------------------------------------------------
// Sync fallback for contexts where async is unavailable (e.g. tests)
// ---------------------------------------------------------------------------

/** Synchronous fallback for dark-background detection using env vars only. */
export function detectDarkSync(opacity?: number): boolean {
	if (opacity !== undefined && opacity < OPACITY_THRESHOLD) return true;
	const fromEnv = detectFromColorfgbg();
	if (fromEnv !== null) return fromEnv;
	return true;
}

// ---------------------------------------------------------------------------
// Alacritty opacity reader — reads opacity from alacritty.toml if available
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// OSC 4 terminal palette query
// ---------------------------------------------------------------------------

/**
 * Query the terminal's actual RGB values for a set of ANSI color slots via OSC 4.
 *
 * OSC 4 format: \x1b]4;N;?\x07 — terminal replies \x1b]4;N;rgb:RRRR/GGGG/BBBB\x07
 *
 * Sends all queries at once, collects responses until all slots are answered
 * or the timeout fires. Returns a map of { slot: "#rrggbb" }.
 *
 * Skips in non-TTY contexts and under multiplexers (tmux/screen intercept OSC).
 */
export async function queryPalette(
	slots: readonly number[],
	timeoutMs = PALETTE_QUERY_TIMEOUT_MS,
): Promise<Record<number, string>> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return {};
	const term = process.env.TERM ?? "";
	if (term.startsWith("tmux") || term.startsWith("screen")) return {};
	if (slots.length === 0) return {};

	return new Promise((resolve) => {
		const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
		const wasRaw = stdin.isRaw;
		const result: Record<number, string> = {};
		const pending = new Set(slots);
		let settled = false;

		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stdin.off("data", onData);
			try {
				if (!wasRaw) stdin.setRawMode(false);
			} catch {
				/* ignore */
			}
			resolve(result);
		};

		const timer = setTimeout(finish, timeoutMs);

		let buf = "";
		const onData = (chunk: Buffer): void => {
			buf += chunk.toString();
			// Parse any complete OSC 4 responses in the buffer.
			// Format: \x1b]4;N;rgb:RRRR/GGGG/BBBB\x07
			const re = /\x1b\]4;(\d+);rgb:([\da-fA-F]+)\/([\da-fA-F]+)\/([\da-fA-F]+)[\x07\x1b\\]/g;
			for (;;) {
				const m = re.exec(buf);
				if (!m) break;
				const slot = Number(m[1]);
				const scale = m[2].length <= COLOR_CHANNEL_8BIT_LENGTH ? COLOR_CHANNEL_8BIT : COLOR_CHANNEL_16BIT;
				const r = Math.round((parseInt(m[2], 16) / scale) * 255);
				const g = Math.round((parseInt(m[3], 16) / scale) * 255);
				const b = Math.round((parseInt(m[4], 16) / scale) * 255);
				result[slot] =
					`#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
				pending.delete(slot);
			}
			if (pending.size === 0) finish();
		};

		try {
			stdin.setRawMode(true);
			stdin.resume();
			stdin.on("data", onData);
			// Send all queries in one write to minimize round-trips.
			process.stdout.write(slots.map((n) => osc4Query(n)).join(""));
		} catch {
			finish();
		}
	});
}

/** Read the window opacity value from alacritty.toml if present. */
export function readAlacrittyOpacity(): number | undefined {
	const candidates = [
		`${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME ?? ""}/.config`}/alacritty/alacritty.toml`,
	];
	for (const path of candidates) {
		try {
			const raw = execFileSync("grep", ["-m1", "^opacity", path], {
				encoding: "utf-8",
				timeout: PALETTE_QUERY_TIMEOUT_MS,
				stdio: ["ignore", "pipe", "ignore"],
			});
			const m = raw.match(/opacity\s*=\s*([\d.]+)/);
			if (m) return parseFloat(m[1]);
		} catch {
			// file not found or grep failed
		}
	}
	return undefined;
}
