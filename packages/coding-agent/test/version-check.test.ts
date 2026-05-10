import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewRelease,
	comparePackageVersions,
	getLatestRelease,
	getLatestVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.js";

const originalSkipVersionCheck = process.env.ALF_SKIP_VERSION_CHECK;
const originalOffline = process.env.ALF_OFFLINE;
const originalLatestUrl = process.env.ALF_LATEST_VERSION_URL;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.ALF_SKIP_VERSION_CHECK;
	} else {
		process.env.ALF_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalOffline === undefined) {
		delete process.env.ALF_OFFLINE;
	} else {
		process.env.ALF_OFFLINE = originalOffline;
	}
	if (originalLatestUrl === undefined) {
		delete process.env.ALF_LATEST_VERSION_URL;
	} else {
		process.env.ALF_LATEST_VERSION_URL = originalLatestUrl;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		process.env.ALF_LATEST_VERSION_URL = "https://versions.example/latest";

		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewRelease("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewRelease("1.2.2")).resolves.toBe("1.2.3");
	});

	it("uses configured endpoint with alf user agent", async () => {
		process.env.ALF_LATEST_VERSION_URL = "https://versions.example/latest";

		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://versions.example/latest",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^alf\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("returns the active package name from the version payload", async () => {
		process.env.ALF_LATEST_VERSION_URL = "https://versions.example/latest";

		const fetchMock = vi.fn(async () => Response.json({ packageName: "@new-scope/coding-agent", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestRelease("1.2.3")).resolves.toEqual({
			packageName: "@new-scope/coding-agent",
			version: "1.2.4",
		});
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.ALF_LATEST_VERSION_URL = "https://versions.example/latest";
		process.env.ALF_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips api calls when no latest-version endpoint is configured", async () => {
		delete process.env.ALF_LATEST_VERSION_URL;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
