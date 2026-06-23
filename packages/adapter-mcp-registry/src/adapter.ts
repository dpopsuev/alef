import { type Adapter, defineAdapter, McpAdapter, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";

export interface McpRegistryAdapterOptions {
	cwd: string;
	agent?: {
		load(adapter: Adapter): void;
		unload(name: string): boolean;
	};
}

/** @deprecated Use McpRegistryAdapterOptions */
export type McpRegistryOrganOptions = McpRegistryAdapterOptions;

// Registry API types
interface RegistryServer {
	server: {
		name: string;
		description: string;
		version: string;
		repository?: {
			url: string;
			source: string;
		};
		packages?: Array<{
			registryType: string;
			identifier: string;
			version: string;
			transport: {
				type: string;
				url?: string;
			};
			runtimeHint?: string;
		}>;
	};
	_meta?: {
		"io.modelcontextprotocol.registry/official"?: {
			status: string;
			publishedAt: string;
			updatedAt: string;
			isLatest: boolean;
		};
	};
}

interface RegistryResponse {
	servers: RegistryServer[];
	metadata?: {
		count?: number;
		nextCursor?: string;
	};
}

const SEARCH_TOOL = {
	name: "mcp.search",
	description:
		"Search the MCP Registry (registry.modelcontextprotocol.io) for available MCP servers. " +
		"Returns server metadata including name, description, installation instructions, and transport details.",
	inputSchema: z.object({
		query: z.string().min(1).describe("Search query to find MCP servers (e.g. 'filesystem', 'github', 'sql')"),
		limit: z.number().optional().describe("Maximum number of results to return (default: 10)"),
	}),
};

const INSTALL_TOOL = {
	name: "mcp.install",
	description:
		"Install and load an MCP server from npm or other package registry. " +
		"Requires the server name from mcp.search results. Supports stdio transport for local MCP servers.",
	inputSchema: z.object({
		serverName: z.string().min(1).describe("Full server name from registry (e.g. 'io.github.owner/repo')"),
		transport: z.enum(["stdio", "http"]).describe("Transport type (stdio for npx/local, http for remote)"),
		config: z
			.object({
				command: z.string().optional().describe("Command to run (default: 'npx' for npm packages)"),
				args: z.array(z.string()).optional().describe("Arguments to pass to the command"),
				url: z.string().optional().describe("URL for http transport"),
			})
			.optional()
			.describe("Configuration for the MCP server"),
	}),
};

const LIST_TOOL = {
	name: "mcp.list",
	description: "List all currently loaded MCP adapters and their tools.",
	inputSchema: z.object({}),
};

export function createMcpRegistryOrgan(opts: McpRegistryAdapterOptions) {
	const loadedAdapters = new Map<string, Adapter>();

	return defineAdapter(
		"mcp-registry",
		{
			command: {
				"mcp.search": typedAction(SEARCH_TOOL, async (ctx) => {
					const { query, limit = 10 } = ctx.payload;

					try {
						const url = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(query)}&limit=${limit}`;
						const response = await fetch(url);

						if (!response.ok) {
							throw new Error(`Registry API error: ${response.status} ${response.statusText}`);
						}

						const data = (await response.json()) as RegistryResponse;
						const servers = data.servers || [];

						// Format results for display
						const results = servers.map((s) => ({
							name: s.server.name,
							description: s.server.description,
							version: s.server.version,
							repository: s.server.repository?.url,
							packages: s.server.packages?.map((p) => ({
								type: p.registryType,
								identifier: p.identifier,
								transport: p.transport.type,
								runtimeHint: p.runtimeHint,
							})),
							status: s._meta?.["io.modelcontextprotocol.registry/official"]?.status,
						}));

						const displayText = results
							.map(
								(r, i) =>
									`${i + 1}. **${r.name}** (${r.version})\n` +
									`   ${r.description}\n` +
									`   Repository: ${r.repository || "N/A"}\n` +
									`   Status: ${r.status || "unknown"}`,
							)
							.join("\n\n");

						return withDisplay(
							{
								query,
								count: results.length,
								servers: results,
							},
							{
								text: `Found ${results.length} MCP server(s) matching "${query}":\n\n${displayText}`,
								mimeType: "text/markdown",
							},
						);
					} catch (error) {
						const errMsg = error instanceof Error ? error.message : String(error);
						return withDisplay(
							{ error: errMsg, query },
							{ text: `Error searching MCP registry: ${errMsg}`, mimeType: "text/plain" },
						);
					}
				}),

				"mcp.install": typedAction(INSTALL_TOOL, async (ctx) => {
					const { serverName, transport, config = {} } = ctx.payload;

					try {
						// Check if already loaded
						if (loadedAdapters.has(serverName)) {
							return withDisplay(
								{ serverName, alreadyLoaded: true },
								{
									text: `MCP server "${serverName}" is already loaded`,
									mimeType: "text/plain",
								},
							);
						}

						let adapter: Adapter;

						if (transport === "stdio") {
							// Default to npx for npm packages
							const command = config.command || "npx";
							const args = config.args || ["-y", serverName];

							adapter = await McpAdapter.stdio(command, args, serverName);
						} else if (transport === "http") {
							if (!config.url) {
								throw new Error("config.url is required for http transport");
							}
							adapter = await McpAdapter.http(config.url, serverName);
						} else {
							throw new Error(`Unsupported transport: ${transport}`);
						}

						loadedAdapters.set(serverName, adapter);
						if (opts.agent) {
							opts.agent.load(adapter);
						}

						const toolCount = adapter.tools?.length || 0;
						const toolNames = adapter.tools?.map((t) => t.name).join(", ") || "none";

						return withDisplay(
							{
								serverName,
								transport,
								toolCount,
								tools: adapter.tools?.map((t) => ({ name: t.name, description: t.description })),
							},
							{
								text:
									`Successfully loaded MCP server "${serverName}"\n` +
									`Transport: ${transport}\n` +
									`Tools (${toolCount}): ${toolNames}`,
								mimeType: "text/plain",
							},
						);
					} catch (error) {
						const errMsg = error instanceof Error ? error.message : String(error);
						return withDisplay(
							{ error: errMsg, serverName },
							{
								text: `Error installing MCP server "${serverName}": ${errMsg}`,
								mimeType: "text/plain",
							},
						);
					}
				}),

				"mcp.list": typedAction(LIST_TOOL, async () => {
					const adapters = Array.from(loadedAdapters.entries()).map(([name, adapter]) => ({
						name,
						toolCount: adapter.tools?.length || 0,
						tools: adapter.tools?.map((t) => ({ name: t.name, description: t.description })),
					}));

					const displayText =
						adapters.length === 0
							? "No MCP servers currently loaded."
							: adapters
									.map(
										(o) =>
											`**${o.name}** (${o.toolCount} tools)\n` +
											o.tools?.map((t) => `  - ${t.name}: ${t.description}`).join("\n"),
									)
									.join("\n\n");

					return withDisplay(
						{
							count: adapters.length,
							adapters,
						},
						{
							text: `Loaded MCP Servers (${adapters.length}):\n\n${displayText}`,
							mimeType: "text/markdown",
						},
					);
				}),
			},
		},
		{
			description:
				"MCP Registry discovery adapter — search, install, and manage Model Context Protocol servers from the official registry.",
			directives: [
				"Use mcp.search to discover MCP servers by keyword (e.g. 'filesystem', 'github', 'database'). " +
					"Results include server metadata, installation instructions, and available transports.",
				"Use mcp.install to load an MCP server and make its tools available. " +
					"Requires serverName from search results. Stdio transport uses npx by default.",
				"Use mcp.list to see all currently loaded MCP servers and their tools.",
				"MCP servers extend the agent's capabilities with external tools. " +
					"Search before installing to verify the server exists and supports your use case.",
			],
			labels: ["mcp-registry", "discovery", "tooling"],
		},
	);
}
