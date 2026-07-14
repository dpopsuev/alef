/**
 * GitHub release checker for auto-update notifications.
 */

/**
 * Release information from GitHub API.
 */
export interface Release {
	version: string;
	changelog: string;
	publishedAt: string;
	htmlUrl: string;
}

/**
 * Check GitHub for the latest release.
 */
export async function checkLatestRelease(owner: string, repo: string, currentVersion: string): Promise<Release | null> {
	try {
		const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
			headers: { Accept: "application/vnd.github.v3+json" },
		});

		if (!response.ok) {
			return null;
		}

		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- GitHub API shape
		const data = (await response.json()) as {
			tag_name: string;
			body: string;
			published_at: string;
			html_url: string;
		};

		const latestVersion = data.tag_name.replace(/^v/, "");

		// Simple version comparison (assumes semver tags like v0.1.0)
		if (latestVersion !== currentVersion && latestVersion > currentVersion) {
			return {
				version: latestVersion,
				changelog: data.body || "No changelog available.",
				publishedAt: data.published_at,
				htmlUrl: data.html_url,
			};
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Start a background watcher that checks for updates periodically.
 */
export function startUpdateWatcher(
	owner: string,
	repo: string,
	currentVersion: string,
	onUpdate: (release: Release) => void,
	intervalMs = 4 * 60 * 60 * 1000, // 4 hours default
): () => void {
	let stopped = false;

	const check = async (): Promise<void> => {
		if (stopped) return;
		const release = await checkLatestRelease(owner, repo, currentVersion);
		if (release) {
			onUpdate(release);
		}
	};

	// Check immediately on start
	check().catch(() => {
		// Ignore errors on background check
	});

	// Then check periodically
	const interval = setInterval(() => {
		check().catch(() => {
			// Ignore errors on background check
		});
	}, intervalMs);

	// Return cleanup function
	return () => {
		stopped = true;
		clearInterval(interval);
	};
}
