/**
 * McpOrgan — import any MCP server as an Alef Organ.
 *
 * Wraps an MCP server (stdio or HTTP) via @ai-sdk/mcp createMCPClient.
 * Discovers tools via mcpClient.tools() (schema discovery mode — automatic).
 * Maps each discovered tool to:
 *   - A ToolDefinition in organ.tools[] (for DialogOrgan to include in LLM payloads)
 *   - A Motor subscription that forwards calls to the MCP server
 *   - A Sense publication of MCP tool results
 *
 * Lifecycle:
 *   McpOrgan.stdio(cmd, args) — creates Organ from local MCP stdio server
 *   McpOrgan.http(url)        — creates Organ from remote MCP HTTP server
 *   unmount()                 — closes mcpClient (stops subprocess for stdio)
 *
 * Consumer DX:
 *   const gh = await McpOrgan.stdio('npx', ['-y', '@modelcontextprotocol/server-github'])
 *   agent.load(gh)  // GitHub tools now available as motor events
 *
 * Ref: ALE-SPC-16, ALE-TSK-176
 */

import type { MCPClient } from "@ai-sdk/mcp";
import { createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Nerve, Organ, ToolDefinition } from "./buses.js";
import { passthroughSchema } from "./buses.js";

// ---------------------------------------------------------------------------
// McpOrgan
// ---------------------------------------------------------------------------

class McpOrganImpl implements Organ {
	readonly name: string;
	readonly description: string;
	readonly labels = ["mcp", "external"] as const;
	readonly tools: readonly ToolDefinition[];
	readonly subscriptions: { readonly motor: readonly string[]; readonly sense: readonly string[] };
	readonly directives?: readonly string[];

	private readonly client: MCPClient;
	/** Map from sanitized LLM tool name → original MCP tool name */
	private readonly nameMap: Map<string, string>;

	constructor(name: string, tools: ToolDefinition[], client: MCPClient, nameMap: Map<string, string>) {
		this.name = name;
		this.description = `MCP organ wrapping the '${name}' server (${tools.length} tools).`;
		this.tools = tools;
		this.client = client;
		this.nameMap = nameMap;
		this.subscriptions = {
			motor: tools.map((t) => t.name),
			sense: [],
		};
	}

	mount(nerve: Nerve): () => void {
		const offs: Array<() => void> = [];

		for (const tool of this.tools) {
			const toolName = tool.name; // e.g. "github.create_issue"
			const mcpName = this.nameMap.get(toolName) ?? toolName; // original MCP name

			const off = nerve.motor.subscribe(toolName, async (event) => {
				const { toolCallId: rawToolCallId, ...args } = event.payload;
				const toolCallId = typeof rawToolCallId === "string" ? rawToolCallId : undefined;
				try {
					const aiTools = await this.client.tools();
					const aiTool = aiTools[mcpName];

					if (!aiTool) {
						throw new Error(`McpOrgan: tool '${mcpName}' not found on MCP server`);
					}
					const execFn = (aiTool as unknown as { execute?: (a: unknown, o: unknown) => Promise<unknown> }).execute;
					if (!execFn) {
						throw new Error(`McpOrgan: tool '${mcpName}' has no execute function`);
					}
					const result: unknown = await execFn(args, { messages: [], toolCallId: String(toolCallId ?? "") });

					nerve.sense.publish({
						type: toolName,
						payload: {
							toolCallId,
							result,
							...(typeof result === "object" && result !== null
								? (result as Record<string, unknown>)
								: { value: result }),
						},
						correlationId: event.correlationId,
						isError: false,
					});
				} catch (err) {
					nerve.sense.publish({
						type: toolName,
						payload: { toolCallId },
						correlationId: event.correlationId,
						isError: true,
						errorMessage: err instanceof Error ? err.message : String(err),
					});
				}
			});

			offs.push(off);
		}

		// eslint-disable-next-line @typescript-eslint/no-misused-promises -- Organ.mount returns () => void; Promise<void> is structurally compatible and the caller does not await unmount
		return async () => {
			for (const off of offs) off();
			await this.client.close();
		};
	}
}

// ---------------------------------------------------------------------------
// McpOrgan factory
// ---------------------------------------------------------------------------

/** Prefix dots in MCP tool names with the organ name for Motor event routing. */
function organToolName(organName: string, mcpName: string): string {
	// MCP tool names like "create_issue" → "github.create_issue"
	// Already namespaced like "filesystem.read_file" → keep as-is but replace _ with .
	return `${organName}.${mcpName.replace(/_/g, "_")}`;
}

/** @internal Exported for testing only. Use McpOrgan.stdio/http in production. */
export async function createMcpOrganFromClient(client: MCPClient, name: string): Promise<Organ> {
	// Discover tools via schema discovery (automatic mode).
	const aiTools = await client.tools();
	const toolNames = Object.keys(aiTools);

	const tools: ToolDefinition[] = [];
	// Map from organ-namespaced name → original MCP name
	const nameMap = new Map<string, string>();

	for (const mcpName of toolNames) {
		const tool = aiTools[mcpName];
		const motorName = organToolName(name, mcpName);
		nameMap.set(motorName, mcpName);

		tools.push({
			name: motorName,
			description: (tool as { description?: string }).description ?? mcpName,
			// MCP returns JSON Schema natively — wrap with passthroughSchema so
			// toolInputToJsonSchema() returns it unchanged to the LLM provider.
			inputSchema: passthroughSchema(
				(tool as { inputSchema?: Record<string, unknown> }).inputSchema ?? { type: "object", properties: {} },
			),
		});
	}

	return new McpOrganImpl(name, tools, client, nameMap);
}

export const McpOrgan = {
	/**
	 * Create an Organ from a local MCP stdio server.
	 *
	 * @param command  Executable to spawn (e.g. 'npx', 'node')
	 * @param args     Arguments (e.g. ['-y', '@modelcontextprotocol/server-github'])
	 * @param name     Organ name. Defaults to the last arg segment.
	 *
	 * @example
	 *   const gh = await McpOrgan.stdio('npx', ['-y', '@modelcontextprotocol/server-github'])
	 *   agent.load(gh)
	 */
	async stdio(command: string, args: string[], name?: string): Promise<Organ> {
		const organName = name ?? args.at(-1)?.split("/").at(-1)?.replace(/^@/, "") ?? "mcp";
		const client = await createMCPClient({
			transport: new StdioClientTransport({ command, args }),
		});
		return createMcpOrganFromClient(client, organName);
	},

	/**
	 * Create an Organ from a remote MCP HTTP server.
	 *
	 * @param url   HTTP/HTTPS URL of the MCP server endpoint
	 * @param name  Organ name. Defaults to the URL hostname.
	 *
	 * @example
	 *   const pg = await McpOrgan.http('https://my-pg-server.example.com/mcp')
	 *   agent.load(pg)
	 */
	async http(url: string, name?: string): Promise<Organ> {
		const organName = name ?? new URL(url).hostname;
		const client = await createMCPClient({
			transport: { type: "http", url },
		});
		return createMcpOrganFromClient(client, organName);
	},
};
