import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// OSC 11 background color query
// ---------------------------------------------------------------------------

export interface BgColor {
	r: number; // 0–1
	g: number;
	b: number;
	a: number; // 0–1
}

export function parseOSC11Response(response: string): BgColor | null {
	// Terminals respond to \x1b]11;?\x07 with:
	//   \x1b]11;rgb:RRRR/GGGG/BBBB\x07       (16-bit channels)
	//   \x1b]11;rgba:RRRR/GGGG/BBBB/AAAA\x07  (with alpha)
	const m = response.match(/\]1[01];rgba?:([\da-fA-F]+)\/([\da-fA-F]+)\/([\da-fA-F]+)(?:\/([\da-fA-F]+))?/);
	if (!m) return null;
	const scale = (m[1]?.length ?? 2) <= 2 ? 255 : 65535;
	return {
		r: parseInt(m[1] ?? "0", 16) / scale,
		g: parseInt(m[2] ?? "0", 16) / scale,
		b: parseInt(m[3] ?? "0", 16) / scale,
		a: m[4] !== undefined ? parseInt(m[4], 16) / scale : 1,
	};
}

export function relativeLuminance(c: Pick<BgColor, "r" | "g" | "b">): number {
	function linear(x: number): number {
		return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
	}
	return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
}

async function queryOSC11(timeoutMs = 50): Promise<BgColor | null> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return null;

	// Multiplexers intercept OSC and responses are unreliable — skip.
	const term = process.env.TERM ?? "";
	if (term.startsWith("tmux") || term.startsWith("screen")) return null;

	return new Promise((resolve) => {
		const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
		const wasRaw = stdin.isRaw ?? false;
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
			process.stdout.write("\x1b]11;?\x07");
		} catch {
			finish(null);
		}
	});
}

// ---------------------------------------------------------------------------
// COLORFGBG heuristic (rxvt, konsole, some others)
// ---------------------------------------------------------------------------

function detectFromColorfgbg(): boolean | null {
	const val = process.env.COLORFGBG ?? "";
	if (!val) return null;
	const parts = val.split(";");
	const bg = parseInt(parts[parts.length - 1] ?? "", 10);
	if (Number.isNaN(bg)) return null;
	return bg < 8;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine whether the terminal background is dark.
 *
 * Priority:
 *   1. opacity < 0.8 → dark (high transparency, desktop showing through)
 *   2. OSC 11 query → parse luminance + alpha from actual terminal bg
 *   3. COLORFGBG env var → rxvt/konsole convention
 *   4. Default: dark
 */
export async function detectDark(opacity?: number): Promise<boolean> {
	if (opacity !== undefined && opacity < 0.8) return true;

	const osc = await queryOSC11();
	if (osc) {
		if (osc.a < 0.8) return true;
		return relativeLuminance(osc) < 0.5;
	}

	const fromEnv = detectFromColorfgbg();
	if (fromEnv !== null) return fromEnv;

	return true;
}

// ---------------------------------------------------------------------------
// Sync fallback for contexts where async is unavailable (e.g. tests)
// ---------------------------------------------------------------------------

export function detectDarkSync(opacity?: number): boolean {
	if (opacity !== undefined && opacity < 0.8) return true;
	const fromEnv = detectFromColorfgbg();
	if (fromEnv !== null) return fromEnv;
	return true;
}

// ---------------------------------------------------------------------------
// Alacritty opacity reader — reads opacity from alacritty.toml if available
// ---------------------------------------------------------------------------

export function readAlacrittyOpacity(): number | undefined {
	const candidates = [
		`${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME ?? ""}/.config`}/alacritty/alacritty.toml`,
	];
	for (const path of candidates) {
		try {
			const raw = execFileSync("grep", ["-m1", "^opacity", path], {
				encoding: "utf-8",
				timeout: 200,
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
