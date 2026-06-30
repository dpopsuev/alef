const REPO = "dpopsuev/alef";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_TIMEOUT_MS = 5_000;

/** Return the running CLI version from the npm_package_version env var. */
function currentVersion(): string {
	return process.env.npm_package_version ?? "0.0.0";
}

/** Compare two semver strings and return true if latest is strictly newer than current. */
function isNewer(latest: string, current: string): boolean {
	const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
	const [lMaj = 0, lMin = 0, lPat = 0] = parse(latest);
	const [cMaj = 0, cMin = 0, cPat = 0] = parse(current);
	if (lMaj !== cMaj) return lMaj > cMaj;
	if (lMin !== cMin) return lMin > cMin;
	return lPat > cPat;
}

/** Fetch the latest release tag from GitHub with a short timeout. */
async function fetchLatestVersion(): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
	try {
		const response = await fetch(API_URL, {
			signal: controller.signal,
			headers: { "User-Agent": `alef/${currentVersion()}` },
		});
		if (!response.ok) return null;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- fetch JSON boundary
		const data = (await response.json()) as { tag_name?: string };
		return data.tag_name ?? null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Check GitHub for a newer release and return an upgrade notice, or null if current. */
export async function checkForUpdate(): Promise<string | null> {
	if (process.env.ALEF_SKIP_UPDATE_CHECK === "1") return null;
	if (process.env.ALEF_OFFLINE === "1") return null;

	const latest = await fetchLatestVersion();
	if (!latest) return null;

	const current = currentVersion();
	if (!isNewer(latest, current)) return null;

	return `New version ${latest} available — run alef update to upgrade (current: v${current})`;
}
