# @dpopsuev/alef-organ-mcp-registry

MCP Registry discovery organ — search, install, and manage Model Context Protocol servers from the official registry.

## Features

- **Search MCP Registry**: Query the official [MCP Registry](https://registry.modelcontextprotocol.io) to find available MCP servers
- **Install MCP Servers**: Dynamically load MCP servers via stdio (npx) or HTTP transport
- **List Loaded Servers**: View all currently loaded MCP organs and their tools

## Tools

### `mcp.search`

Search the MCP Registry for available MCP servers.

**Parameters:**
- `query` (string, required): Search query to find MCP servers (e.g. 'filesystem', 'github', 'sql')
- `limit` (number, optional): Maximum number of results to return (default: 10)

**Returns:**
- `query`: The search query used
- `count`: Number of servers found
- `servers`: Array of server metadata including name, description, version, repository, and packages

**Example:**
```typescript
await agent.call("mcp.search", { query: "filesystem", limit: 5 });
```

### `mcp.install`

Install and load an MCP server from npm or other package registry.

**Parameters:**
- `serverName` (string, required): Full server name from registry (e.g. 'io.github.owner/repo')
- `transport` (enum: "stdio" | "http", required): Transport type
  - `stdio`: For local MCP servers (uses npx by default)
  - `http`: For remote HTTP-based MCP servers
- `config` (object, optional):
  - `command` (string): Command to run (default: 'npx' for stdio transport)
  - `args` (array of strings): Arguments to pass to the command
  - `url` (string): URL for HTTP transport (required for http transport)

**Returns:**
- `serverName`: The name of the installed server
- `transport`: Transport type used
- `toolCount`: Number of tools provided by the server
- `tools`: Array of tool definitions

**Example:**
```typescript
// Install from npm using npx (default)
await agent.call("mcp.install", {
  serverName: "io.github.bytedance/mcp-server-filesystem",
  transport: "stdio"
});

// Install with custom command
await agent.call("mcp.install", {
  serverName: "io.github.owner/custom-server",
  transport: "stdio",
  config: {
    command: "npx",
    args: ["-y", "@custom/mcp-server"]
  }
});

// Install HTTP server
await agent.call("mcp.install", {
  serverName: "remote-server",
  transport: "http",
  config: {
    url: "https://mcp.example.com"
  }
});
```

### `mcp.list`

List all currently loaded MCP organs and their tools.

**Parameters:** None

**Returns:**
- `count`: Number of loaded MCP organs
- `organs`: Array of loaded organs with their tools

**Example:**
```typescript
await agent.call("mcp.list", {});
```

## Usage

```typescript
import { createMcpRegistryOrgan } from "@dpopsuev/alef-organ-mcp-registry";

// Create the organ
const mcpRegistry = createMcpRegistryOrgan({ cwd: process.cwd() });

// Load it into your agent
agent.load(mcpRegistry);

// Now you can use the tools
const searchResults = await agent.call("mcp.search", {
  query: "filesystem",
  limit: 10
});

// Install a server
await agent.call("mcp.install", {
  serverName: "io.github.bytedance/mcp-server-filesystem",
  transport: "stdio"
});

// List loaded servers
await agent.call("mcp.list", {});
```

## Development

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

## Architecture

The organ maintains an internal map of loaded MCP servers using `McpOrgan.stdio()` and `McpOrgan.http()` from the kernel. When you install a server:

1. The organ checks if it's already loaded
2. It creates an MCP client using the appropriate transport
3. The MCP client discovers tools from the server
4. The organ stores the loaded organ in its internal map
5. The tools become available for use

## API Reference

The MCP Registry API is documented at:
- OpenAPI Spec: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md
- Base URL: https://registry.modelcontextprotocol.io/v0

## License

MIT
