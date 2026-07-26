import { filesystemPortConformanceSuite } from "@dpopsuev/alef-workspace/filesystem-port-conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LectorFilesystemPort } from "../src/filesystem-port.js";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../src/client.js";
import { resetWorkspaceRegistrationForTests } from "../src/workspace-registration.js";
import { type IsolatedLectorDaemon, startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.js";

describe("LectorFilesystemPort", { tags: ["integration"], timeout: 30_000 }, () => {
	let daemon: IsolatedLectorDaemon;

	beforeAll(async () => {
		daemon = await startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
	});

	afterAll(async () => {
		resetLectorClientForTests();
		await daemon.stop();
	});

	filesystemPortConformanceSuite(() => {
		resetWorkspaceRegistrationForTests();
		return new LectorFilesystemPort(daemon.workspaceRoot);
	});
});
