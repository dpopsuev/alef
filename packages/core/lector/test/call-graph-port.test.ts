import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLectorClientConnectorForTests } from "../src/client.js";
import { LectorCallGraphPort } from "../src/call-graph-port.js";
import { resetWorkspaceRegistrationForTests } from "../src/workspace-registration.js";
import { createFakeLectorClient } from "./support/fake-lector-client.js";

const AT = { path: "src/index.ts", line: 10, character: 5 };

describe("LectorCallGraphPort", { tags: ["unit"] }, () => {
	beforeEach(() => {
		resetWorkspaceRegistrationForTests();
	});

	afterEach(() => {
		setLectorClientConnectorForTests(() => Promise.reject(new Error("not configured for this test")));
	});

	it("populateSymbolGraph forwards maxFiles/maxSymbolsPerFile and maps the result fields", async () => {
		const { client, calls } = createFakeLectorClient({
			"workspace.registerPath": { workspaceId: "ws1", created: true },
			"workspace.populateSymbolGraph": {
				completeness: "complete",
				filesAttempted: 10,
				filesProcessed: 10,
				filesFailed: 0,
				symbolsProcessed: 40,
				nodesAdded: 40,
				edgesAdded: 12,
				failureCount: 0,
				failures: [],
				failuresTruncated: false,
			},
		});
		setLectorClientConnectorForTests(() => Promise.resolve(client));

		const port = new LectorCallGraphPort("/tmp/project");
		const result = await port.populateSymbolGraph(500, 200);

		expect(result).toEqual({ completeness: "complete", filesProcessed: 10, filesFailed: 0, nodesAdded: 40, edgesAdded: 12 });
		expect(calls.find((c) => c.operation === "workspace.populateSymbolGraph")?.input).toEqual({ workspaceId: "ws1", maxFiles: 500, maxSymbolsPerFile: 200 });
	});

	it("reachableFrom requires and forwards maxDepth, and an optional edge kind", async () => {
		const node = { id: "n1", name: "foo", kind: "function", location: AT };
		const { client, calls } = createFakeLectorClient({
			"workspace.registerPath": { workspaceId: "ws1", created: true },
			"workspace.reachableFrom": { symbols: [node] },
		});
		setLectorClientConnectorForTests(() => Promise.resolve(client));

		const port = new LectorCallGraphPort("/tmp/project");
		const result = await port.reachableFrom(AT, 3, "calls");

		expect(result).toEqual([node]);
		expect(calls.find((c) => c.operation === "workspace.reachableFrom")?.input).toEqual({
			workspaceId: "ws1",
			path: AT.path,
			line: AT.line,
			character: AT.character,
			maxDepth: 3,
			kind: "calls",
		});
	});

	it("edgesFrom and edgesTo resolve direct edges without a depth bound", async () => {
		const { client, calls } = createFakeLectorClient({
			"workspace.registerPath": { workspaceId: "ws1", created: true },
			"workspace.symbolEdgesFrom": { symbols: [] },
			"workspace.symbolEdgesTo": { symbols: [] },
		});
		setLectorClientConnectorForTests(() => Promise.resolve(client));

		const port = new LectorCallGraphPort("/tmp/project");
		await port.edgesFrom(AT);
		await port.edgesTo(AT);

		expect(calls.find((c) => c.operation === "workspace.symbolEdgesFrom")?.input).toEqual({
			workspaceId: "ws1",
			path: AT.path,
			line: AT.line,
			character: AT.character,
			kind: undefined,
		});
	});
});
