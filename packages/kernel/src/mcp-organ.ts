/**
 * McpOrgan — import any MCP server as an Alef Organ.
 *
 * Wraps an MCP server (stdio or HTTP) via @ai-sdk/mcp createMCPClient.
 * Discovers tools via mcpClient.tools() (schema discovery mode — automatic).
 * Maps each discovered tool to:
 * - A ToolDefinition in organ.tools[] (for AgentController to include in LLM payloads)
 * - A Motor subscription that forwards calls to the MCP server
 * - A Sense publication of MCP tool results
 *
 * Lifecycle:
 * McpOrgan.stdio(cmd, args) — creates Organ from local MCP stdio server
 * McpOrgan.http(url) — creates Organ from remote MCP HTTP server
 * unmount() — closes mcpClient (stops subprocess for stdio)
 *
 * Consumer DX:
 * const gh = await McpOrgan.stdio('npx', ['-y', '@modelcontextprotocol/server-github'])
 * agent.load(gh) // GitHub tools now available as motor events
 *
 */

import type { MCPClient } from "@ai-sdk/mcp";
import { createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Nerve, Organ, ToolDefinition } from "./buses.js";
import { passthroughSchema } from "./buses.js";

// ---------------------------------------------------------------------------
// McpOrgan
// ---------------------------------------------------------------------------

type ExecuteFn = (args: unknown, opts: unknown) => Promise<unknown>;

class McpOrganImpl implements Organ {
	readonly name: string;
	readonly description: string;
	readonly labels = ["mcp", "external"] as const;
	readonly tools: readonly ToolDefinition[];
	readonly subscriptions: { readonly motor: readonly string[]; readonly sense: readonly string[] };
	readonly sources: readonly { readonly name: string; readonly kind: "file" | "memory" | "process" }[] = [];
	readonly directives?: readonly string[];

	private readonly client: MCPClient;
	/** Map from motor tool name → cached execute function */
	private readonly execMap: Map<string, ExecuteFn>;

	constructor(name: string, tools: ToolDefinition[], client: MCPClient, execMap: Map<string, ExecuteFn>) {
		this.name = name;
		this.description = `MCP organ wrapping the '${name}' server (${tools.length} tools).`;
		this.tools = tools;
		this.client = client;
		this.execMap = execMap;
		this.subscriptions = {
			motor: tools.map((t) => t.name),
			sense: [],
		};
	}

	async close(): Promise<void> {
		await this.client.close();
	}

	mount(nerve: Nerve): () => void {
		const offs: Array<() => void> = [];

		for (const tool of this.tools) {
			const toolName = tool.name; // e.g. "github.create_issue"
			const execFn = this.execMap.get(toolName);

			const off = nerve.motor.subscribe(toolName, async (event) => {
				const { toolCallId: rawToolCallId, ...args } = event.payload;
				const toolCallId = typeof rawToolCallId === "string" ? rawToolCallId : undefined;
				try {
					if (!execFn) {
						throw new Error(`McpOrgan: no execute function for tool '${toolName}'`);
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

		return () => {
			for (const off of offs) off();
		};
	}
}

// ---------------------------------------------------------------------------
// McpOrgan factory
// ---------------------------------------------------------------------------

/** Prefix the organ name onto an MCP tool name for Motor event routing. */
function organToolName(organName: string, mcpName: string): string {
	return `${organName}.${mcpName}`;
}

/** @internal Exported for testing only. Use McpOrgan.stdio/http in production. */
export async function createMcpOrganFromClient(client: MCPClient, name: string): Promise<Organ> {
	const aiTools = await client.tools();
	const toolNames = Object.keys(aiTools);

	const tools: ToolDefinition[] = [];
	const execMap = new Map<string, ExecuteFn>();

	for (const mcpName of toolNames) {
		const tool = aiTools[mcpName];
		const motorName = organToolName(name, mcpName);
		const execFn = (tool as unknown as { execute?: ExecuteFn }).execute;
		if (execFn) execMap.set(motorName, execFn);

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

	return new McpOrganImpl(name, tools, client, execMap);
}

export const McpOrgan = {
	/**
	 * Create an Organ from a local MCP stdio server.
	 *
	 * @param command Executable to spawn (e.g. 'npx', 'node')
	 * @param args Arguments (e.g. ['-y', '@modelcontextprotocol/server-github'])
	 * @param name Organ name. Defaults to the last arg segment.
	 *
	 * @example
	 * const gh = await McpOrgan.stdio('npx', ['-y', '@modelcontextprotocol/server-github'])
	 * agent.load(gh)
	 */
	async stdio(command: string, args: string[], name?: string, env?: Record<string, string>): Promise<Organ> {
		const organName = name ?? args.at(-1)?.split("/").at(-1)?.replace(/^@/, "") ?? "mcp";
		const transportOpts: { command: string; args: string[]; env?: Record<string, string> } = { command, args };
		if (env) transportOpts.env = { ...process.env, ...env } as Record<string, string>;
		const client = await createMCPClient({
			transport: new StdioClientTransport(transportOpts),
		});
		return createMcpOrganFromClient(client, organName);
	},

	/**
	 * Create an Organ from a remote MCP HTTP server.
	 *
	 * @param url HTTP/HTTPS URL of the MCP server endpoint
	 * @param name Organ name. Defaults to the URL hostname.
	 *
	 * @example
	 * const pg = await McpOrgan.http('https://my-pg-server.example.com/mcp')
	 * agent.load(pg)
	 */
	async http(url: string, name?: string): Promise<Organ> {
		const organName = name ?? new URL(url).hostname;
		const client = await createMCPClient({
			transport: { type: "http", url },
		});
		return createMcpOrganFromClient(client, organName);
	},
};
