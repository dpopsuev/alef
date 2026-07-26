import type { IntelligenceProvenance } from "@danypops/lector";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLectorClientConnectorForTests } from "../src/client.js";
import { LectorCodeIntelligencePort } from "../src/code-intelligence-port.js";
import { resetWorkspaceRegistrationForTests } from "../src/workspace-registration.js";
import { createFakeLectorClient } from "./support/fake-lector-client.js";

const PROVENANCE = { languageId: "typescript", backend: "lsp", status: "ok" } as unknown as IntelligenceProvenance;
const AT = { path: "src/index.ts", line: 10, character: 5 };

describe("LectorCodeIntelligencePort", { tags: ["unit"] }, () => {
	beforeEach(() => {
		resetWorkspaceRegistrationForTests();
	});

	afterEach(() => {
		setLectorClientConnectorForTests(() => Promise.reject(new Error("not configured for this test")));
	});

	it("goToDefinition translates a WorkspacePosition into a workspace.goToDefinition call and unwraps the locations", async () => {
		const location = { path: "src/other.ts", line: 3, character: 1 };
		const { client, calls } = createFakeLectorClient({
			"workspace.registerPath": { workspaceId: "ws1", created: true },
			"workspace.goToDefinition": { locations: [location], provenance: PROVENANCE },
		});
		setLectorClientConnectorForTests(() => Promise.resolve(client));

		const port = new LectorCodeIntelligencePort("/tmp/project");
		const result = await port.goToDefinition(AT);

		expect(result).toEqual([location]);
		const call = calls.find((c) => c.operation === "workspace.goToDefinition");
		expect(call?.input).toEqual({ workspaceId: "ws1", path: AT.path, line: AT.line, character: AT.character });
	});

	it("hover returns undefined when the server has no hover for the position", async () => {
		const { client } = createFakeLectorClient({
			"workspace.registerPath": { workspaceId: "ws1", created: true },
			"workspace.hover": { hover: undefined, provenance: PROVENANCE },
		});
		setLectorClientConnectorForTests(() => Promise.resolve(client));

		const port = new LectorCodeIntelligencePort("/tmp/project");
		expect(await port.hover(AT)).toBeUndefined();
	});

	it("findReferences forwards includeDeclaration alongside the position", async () => {
		const { client, calls } = createFakeLectorClient({
			"workspace.registerPath": { workspaceId: "ws1", created: true },
			"workspace.findReferences": { locations: [], provenance: PROVENANCE },
		});
		setLectorClientConnectorForTests(() => Promise.resolve(client));

		const port = new LectorCodeIntelligencePort("/tmp/project");
		await port.findReferences(AT, true);

		const call = calls.find((c) => c.operation === "workspace.findReferences");
		expect(call?.input).toEqual({ workspaceId: "ws1", path: AT.path, line: AT.line, character: AT.character, includeDeclaration: true });
	});

	it("documentSymbols and diagnostics resolve by path only, not a position", async () => {
		const { client, calls } = createFakeLectorClient({
			"workspace.registerPath": { workspaceId: "ws1", created: true },
			"workspace.documentSymbols": { symbols: [], provenance: PROVENANCE },
			"workspace.diagnostics": { diagnostics: [], provenance: PROVENANCE },
		});
		setLectorClientConnectorForTests(() => Promise.resolve(client));

		const port = new LectorCodeIntelligencePort("/tmp/project");
		await port.documentSymbols("src/index.ts");
		await port.diagnostics("src/index.ts");

		expect(calls.find((c) => c.operation === "workspace.documentSymbols")?.input).toEqual({ workspaceId: "ws1", path: "src/index.ts" });
		expect(calls.find((c) => c.operation === "workspace.diagnostics")?.input).toEqual({ workspaceId: "ws1", path: "src/index.ts" });
	});
});
