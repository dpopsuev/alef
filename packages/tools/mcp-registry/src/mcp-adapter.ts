/**
 * McpAdapter — import any MCP server as an Alef Adapter.
 *
 * Wraps an MCP server (stdio or HTTP) via @ai-sdk/mcp createMCPClient.
 * Discovers tools via mcpClient.tools() (schema discovery mode — automatic).
 *
 * Consumer DX:
 * const gh = await McpAdapter.stdio('npx', ['-y', '@modelcontextprotocol/server-github'])
 * agent.load(gh)
 */

import type { MCPClient } from "@ai-sdk/mcp";
import { createMCPClient } from "@ai-sdk/mcp";
import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import { passthroughSchema } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ExecuteFn = (args: unknown, opts: unknown) => Promise<unknown>;

class McpAdapterImpl implements Adapter {
	readonly name: string;
	readonly description: string;
	readonly labels = ["mcp", "external"] as const;
	readonly tools: readonly ToolDefinition[];
	readonly subscriptions: Adapter["subscriptions"];
	readonly sources: readonly { readonly name: string; readonly kind: "file" | "memory" | "process" }[] = [];
	readonly directives?: readonly string[];

	private readonly client: MCPClient;
	/** Map from command tool name → cached execute function */
	private readonly execMap: Map<string, ExecuteFn>;

	constructor(name: string, tools: ToolDefinition[], client: MCPClient, execMap: Map<string, ExecuteFn>) {
		this.name = name;
		this.description = `MCP adapter wrapping the '${name}' server (${tools.length} tools).`;
		this.tools = tools;
		this.client = client;
		this.execMap = execMap;
		this.subscriptions = {
			command: tools.map((t) => t.name),
			event: [],
			notification: [],
		};
	}

	async close(): Promise<void> {
		await this.client.close();
	}

	mount(bus: Bus): () => void {
		const offs: Array<() => void> = [];

		for (const tool of this.tools) {
			const toolName = tool.name; // e.g. "github.create_issue"
			const execFn = this.execMap.get(toolName);

			const off = bus.command.subscribe(toolName, async (event) => {
				const { toolCallId: rawToolCallId, ...args } = event.payload;
				const toolCallId = typeof rawToolCallId === "string" ? rawToolCallId : undefined;
				try {
					if (!execFn) {
						throw new Error(`McpAdapter: no execute function for tool '${toolName}'`);
					}
					const result: unknown = await execFn(args, { messages: [], toolCallId: String(toolCallId ?? "") });

					bus.event.publish({
						type: toolName,
						payload: {
							toolCallId,
							result,
							...(typeof result === "object" && result !== null
								// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime-guarded object spread
								? (result as Record<string, unknown>)
								: { value: result }),
						},
						correlationId: event.correlationId,
						isError: false,
					});
				} catch (err) {
					bus.event.publish({
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

function adapterToolName(adapterName: string, mcpName: string): string {
	return `${adapterName}.${mcpName}`;
}

/** @internal Exported for testing only. Use McpAdapter.stdio/http in production. */
export async function createMcpAdapterFromClient(client: MCPClient, name: string): Promise<Adapter> {
	const aiTools = await client.tools();
	const toolNames = Object.keys(aiTools);

	const tools: ToolDefinition[] = [];
	const execMap = new Map<string, ExecuteFn>();

	for (const mcpName of toolNames) {
		const tool = aiTools[mcpName];
		const motorName = adapterToolName(name, mcpName);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- MCP tool shape not statically typed
		const execFn = (tool as unknown as { execute?: ExecuteFn }).execute;
		if (execFn) execMap.set(motorName, execFn);

		tools.push({
			name: motorName,
			description: (tool as { description?: string }).description ?? mcpName,
			// MCP returns JSON Schema natively — wrap with passthroughSchema so
			// toolInputToJsonSchema() returns it unchanged to the LLM provider.
			inputSchema: passthroughSchema(
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- MCP tool shape not statically typed
				(tool as { inputSchema?: Record<string, unknown> }).inputSchema ?? { type: "object", properties: {} },
			),
		});
	}

	return new McpAdapterImpl(name, tools, client, execMap);
}

export const McpAdapter = {
	async stdio(command: string, args: string[], name?: string, env?: Record<string, string>): Promise<Adapter> {
		const adapterName = name ?? args.at(-1)?.split("/").at(-1)?.replace(/^@/, "") ?? "mcp";
		const transportOpts: { command: string; args: string[]; env?: Record<string, string> } = { command, args };
		if (env) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- undefined values filtered out above
			const filteredEnv = Object.fromEntries(
				Object.entries({ ...process.env, ...env }).filter(([_, v]) => v !== undefined),
			) as Record<string, string>;
			transportOpts.env = filteredEnv;
		}
		const client = await createMCPClient({
			transport: new StdioClientTransport(transportOpts),
		});
		return createMcpAdapterFromClient(client, adapterName);
	},

	async http(url: string, name?: string): Promise<Adapter> {
		const adapterName = name ?? new URL(url).hostname;
		const client = await createMCPClient({
			transport: { type: "http", url },
		});
		return createMcpAdapterFromClient(client, adapterName);
	},
};
