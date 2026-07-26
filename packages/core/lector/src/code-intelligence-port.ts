import type {
	CallHierarchyEntry,
	CodeIntelligencePort,
	Diagnostic,
	DocumentSymbolEntry,
	Hover,
	IncomingCall,
	OutgoingCall,
	WorkspaceLocation,
	WorkspacePosition,
} from "@dpopsuev/alef-workspace/code-intelligence-port";
import { callLector } from "./client.js";
import { registerWorkspace } from "./workspace-registration.js";

/** CodeIntelligencePort backed by a real Lector daemon's warm language-server-backed operations. */
export class LectorCodeIntelligencePort implements CodeIntelligencePort {
	readonly version = 1 as const;

	constructor(private readonly root: string) {}

	private async position(at: WorkspacePosition): Promise<{ workspaceId: string; path: string; line: number; character: number }> {
		const workspaceId = await registerWorkspace(this.root);
		return { workspaceId, path: at.path, line: at.line, character: at.character };
	}

	async goToDefinition(at: WorkspacePosition): Promise<readonly WorkspaceLocation[]> {
		const { locations } = await callLector("workspace.goToDefinition", await this.position(at));
		return locations;
	}

	async goToImplementation(at: WorkspacePosition): Promise<readonly WorkspaceLocation[]> {
		const { locations } = await callLector("workspace.goToImplementation", await this.position(at));
		return locations;
	}

	async findReferences(at: WorkspacePosition, includeDeclaration: boolean): Promise<readonly WorkspaceLocation[]> {
		const { locations } = await callLector("workspace.findReferences", { ...(await this.position(at)), includeDeclaration });
		return locations;
	}

	async hover(at: WorkspacePosition): Promise<Hover | undefined> {
		const { hover } = await callLector("workspace.hover", await this.position(at));
		return hover;
	}

	async documentSymbols(path: string): Promise<readonly DocumentSymbolEntry[]> {
		const workspaceId = await registerWorkspace(this.root);
		const { symbols } = await callLector("workspace.documentSymbols", { workspaceId, path });
		return symbols;
	}

	async diagnostics(path: string): Promise<readonly Diagnostic[]> {
		const workspaceId = await registerWorkspace(this.root);
		const { diagnostics } = await callLector("workspace.diagnostics", { workspaceId, path });
		return diagnostics;
	}

	async prepareCallHierarchy(at: WorkspacePosition): Promise<readonly CallHierarchyEntry[]> {
		const { items } = await callLector("workspace.prepareCallHierarchy", await this.position(at));
		return items;
	}

	async incomingCalls(at: WorkspacePosition): Promise<readonly IncomingCall[]> {
		const { calls } = await callLector("workspace.incomingCalls", await this.position(at));
		return calls;
	}

	async outgoingCalls(at: WorkspacePosition): Promise<readonly OutgoingCall[]> {
		const { calls } = await callLector("workspace.outgoingCalls", await this.position(at));
		return calls;
	}
}
