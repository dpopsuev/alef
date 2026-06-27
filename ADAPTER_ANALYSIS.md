# Alef Kernel Framework: Adapter Domain Analysis

## Executive Summary

Alef's adapter architecture implements a **capability-based orchestration model** where domain functionality is exposed through composable adapters. Each adapter integrates with the kernel via:

1. **Bus integration** - Event-driven command/event/notification channels
2. **Tool definitions** - Zod-validated schemas with streaming support
3. **Contribution system** - Context assembly, UI signals, event weights, reasoning extensions
4. **Lifecycle hooks** - Mount/unmount, readiness gates, cache invalidation

This analysis maps **18 adapters** across **7 functional domains**, documenting their capabilities, kernel integration patterns, and architectural role.

---

## Domain Classification

### 1. **Filesystem & Code Intelligence** (4 adapters)
Core read/write and structural code analysis capabilities.

### 2. **Execution & Process Management** (3 adapters)
Shell execution, JavaScript evaluation, sandboxed workspaces.

### 3. **Agent Orchestration** (4 adapters)
Delegation, subagent lifecycle, blue-green deployment, evaluation.

### 4. **Web & External Data** (2 adapters)
HTTP fetch, web search, external MCP servers.

### 5. **Planning & Workflow** (2 adapters)
Structured task planning, contract-based validation pipelines.

### 6. **Knowledge & Context** (2 adapters)
Session history, skill libraries, artifact graphs, multi-agent coordination.

### 7. **Development Tools** (1 adapter)
Adapter scaffolding and blueprint generation.

---

## Adapter Catalog

### Domain 1: Filesystem & Code Intelligence

#### **fs** - Filesystem Operations
**Capabilities:**
- Read files with pagination/truncation (`fs.read`)
- Content search via ripgrep (`fs.grep`)
- File discovery via fd (`fs.find`)
- Exact-text replacement (`fs.edit`)
- Full file writes (`fs.write`)
- Multi-file atomic patches (`fs.patch`)
- Undo last write/edit (`fs.undo`)

**Kernel Integration:**
```typescript
// Port definition - declares exclusive ownership
contributions: {
  port: {
    name: "filesystem",
    eventPattern: "command/fs.",
    cardinality: "zero-or-one"
  }
}

// Event weights - influences prompt selection
"event.weights": {
  "fs.write": 2.0,  // High-impact write
  "fs.edit": 2.0,
  "fs.read": 1.0,   // Read access
  "fs.grep": 0.6,   // Query access
  "fs.find": 0.6
}

// Cache invalidation - writes clear read cache
typedAction(FS_WRITE_TOOL, handler, {
  invalidates: () => ["fs.read", "fs.grep"]
})
```

**Domain Features:**
- **FileTracker** - Read-before-edit enforcement, staleness detection
- **WriteQueue** - Per-path serialization prevents concurrent write races
- **FsRuntime** - Cache scopes for grep/find query acceleration
- **OCAP security** - `writableRoots` allowlist, path traversal guards
- **Formatter integration** - Auto-run Prettier/dprint after writes

**Guards:**
- Binary file detection (magic bytes + null-byte heuristic)
- Read staleness check (mtime > last read time → reject edit)
- Exact-text uniqueness (edit.oldText must match exactly once)

---

#### **code-intel** - LSP-Based Code Intelligence
**Capabilities:**
- Workspace-wide symbol search (`code.symbols`)
- Hover type info + JSDoc (`code.hover`)
- Find all call sites of a symbol (`code.callers`)
- TypeScript diagnostics (`code.diagnose`)
- Git diff review stub (`code.review`)

**Kernel Integration:**
```typescript
// Tool caching - LSP responses are stable
typedAction(SYMBOLS_TOOL, handler, {
  shouldCache: () => true
})

// Event weights - LSP queries are heavyweight
"event.weights": {
  "code.write": 2.0,
  "code.edit": 2.0,
  "code.read": 1.0,
  "code.callers": 1.0,
  "code.search": 0.6
}

// Lifecycle - LSP warmup + cleanup
{
  ready: () => backend.warmUp(),
  onUnmount: () => backend.stopLsp()
}
```

**Backend Abstraction:**
- **LocalCodeIntelBackend** - LSP client (tsserver) + grep fallback
- **StubCodeIntelBackend** - No-op for tests
- **DockerCodeIntelBackend** - Enclosure integration (future)

**Domain Strategy:**
- Pure intelligence layer - no file I/O (delegates to `fs`)
- TypeScript-first - other languages fall back to grep
- LSP lifecycle - lazy start, process cleanup on unmount

---

#### **locus** - Architecture Analysis (MCP Bridge)
**Capabilities:**
- Codograph scanning (`locus.codograph`)
- Dependency/coupling/impact analysis (`locus.analysis`)
- Mermaid diagram rendering (`locus.render_diagram`)

**Kernel Integration:**
```typescript
// MCP adapter bridge
mount(bus: Bus): () => void {
  const bootPromise = McpAdapter.stdio(binary, args, "locus", env)
    .then(mcpAdapter => {
      inner = mcpAdapter;
      // Dynamic tool registration
      adapter.tools = mcpAdapter.tools;
      adapter.subscriptions.command = mcpAdapter.tools.map(t => t.name);
      innerCleanup = mcpAdapter.mount(bus);
      
      // Announce to kernel
      bus.event.publish({
        type: "adapter.loaded",
        payload: { name: "locus", tools: [...] }
      });
    });
}
```

**Design Pattern:**
- **Lazy boot** - Binary spawns on mount, not construction
- **MCP stdio bridge** - Wraps external Locus process
- **Tool discovery** - Tools not known until boot completes
- **Separate data dirs** - `LOCUS_CACHE_DIR`, `LOCUS_HISTORY_DIR`

---

#### **scribe** - Work Graph & Knowledge Base (MCP Bridge)
**Capabilities:**
- Artifact CRUD (`scribe.artifact`)
- Task dispatch, dependency graphs
- Agent memory persistence (`kind=agent.memory`)
- Wikilink resolution (`[[artifact-id]]`)

**Kernel Integration:**
```typescript
// Context assembly - injects knowledge base into system prompt
contributions: {
  "context.assemble": async (input) => {
    const newPosts = queryRecentNotes();
    const block = buildContextBlock(dashboard, notes);
    const messages = [...input.messages];
    const systemIdx = messages.findIndex(m => m.role === "system");
    messages[systemIdx] = { ...sys, content: `${sys.content}\n\n${block}` };
    return { messages };
  }
}

// Source declaration
sources: [{ name: "scribe-db", kind: "process" }]
```

**Context Refresh Strategy:**
- Poll every 10 turns via `turnsSinceRefresh` counter
- Query `scribe.artifact(action=dashboard)` for sources
- Query `scribe.artifact(action=query, kind=agent.memory)` for notes
- Cache in adapter state, inject into system message

**Persistence Model:**
- SQLite database (`$XDG_DATA_HOME/alef/scribe.db`)
- Cross-session persistence
- Wikilink auto-resolution on turn record

---

### Domain 2: Execution & Process Management

#### **shell** - Shell Command Execution
**Capabilities:**
- Streaming command execution (`shell.exec`)
- Persistent PTY sessions (optional, `usePty: true`)
- CPU stall detection (Linux `/proc/PID/stat`)
- Timeout enforcement (SIGTERM → SIGKILL escalation)

**Kernel Integration:**
```typescript
// Streaming action
typedStreamAction(SHELL_EXEC_TOOL, async function* (ctx) {
  for await (const buf of pushQueue<Buffer>(...)) {
    yield { chunk: buf.toString("utf-8") };
  }
  yield withDisplay({ output, exitCode, truncated }, ...);
})

// Event weights
"event.weights": { "shell.exec": 1.5 }

// Port definition
contributions: {
  port: {
    name: "shell",
    eventPattern: "command/shell.",
    cardinality: "zero-or-one"
  }
}
```

**Guard Rules:**
Built-in structural enforcement prevents:
- `git commit --no-verify` (bypasses hooks)
- `git reset --hard` (destructive)
- `git push --force` without `--force-with-lease`
- `git clean -f` (untracked file deletion)
- `rm -rf /` or `rm -rf ~` (recursive root deletion)
- Large heredoc output (`cat <<EOF` > 500 chars)

**PTY Pool (Optional):**
- Per-cwd terminal sessions
- `cd` / env / aliases persist across calls
- Managed by `pty-manager` package
- `ShellAdapter` from `pty-manager`

**Timeout Layers:**
1. **Hard timeout** - `setTimeout(() => child.kill("SIGTERM"), timeoutMs)`
2. **CPU stall detector** - `/proc/PID/stat` polling (Linux only)
3. **SIGKILL escalation** - 5s after SIGTERM

**Design Trade-offs:**
- One-shot spawn vs persistent PTY
- Spawn: isolated, no state leaks
- PTY: persistent env, `cd` works across calls

---

#### **nodesh** - JavaScript REPL
**Capabilities:**
- Expression evaluation (`nodesh.eval`)
- Statement block execution (with `result = ...`)
- Async/await support (auto-wraps in IIFE)
- Sandboxed require (allowlist-based)

**Kernel Integration:**
```typescript
// Fresh context per call
async function handleEval(ctx, opts) {
  const sandbox = {
    require: makeSandboxedRequire(allowed),
    console: { log: (...args) => stdout.push(...), ... },
    process: { cwd: () => opts.cwd, env, platform },
    result: undefined
  };
  const context = vm.createContext(sandbox);
  
  // Run prelude
  vm.runInContext(opts.prelude, context, { timeout });
  
  // Run user code
  const returnValue = await vm.runInContext(code, context, { timeout });
  return { result: sandbox.result ?? returnValue, stdout };
}
```

**Security Model:**
- **Allowlist-only modules** - `ALLOWED_BUILTINS` + `extraAllowedModules`
- **No child_process** - Intentionally excluded
- **Fresh context per call** - No variable leaks between turns
- **Timeout enforcement** - Default 10s, max 30s

**Use Cases:**
- Data transformation (JSON/CSV/XML)
- Math/crypto operations
- Alef API introspection (`getModels()`)
- **NOT for**: system tasks (use `shell.exec`)

**Default Allowlist:**
```typescript
const ALLOWED_BUILTINS = new Set([
  "node:path", "path",
  "node:url", "url",
  "node:crypto", "crypto",
  "node:util", "util",
  "node:buffer", "buffer",
  "node:stream", "stream",
  "node:events", "events",
  "node:os", "os"
]);
```

---

#### **enclosure** - Isolated Workspaces
**Capabilities:**
- Copy-on-write workspace overlay (`enclosure.create`)
- Change tracking (`enclosure.diff`)
- Selective promotion (`enclosure.commit`)
- Snapshot/restore (`enclosure.snapshot`, `enclosure.restore`)
- Confined execution (`enclosure.exec`)
- Teardown (`enclosure.destroy`)

**Kernel Integration:**
```typescript
// UI signals
contributions: {
  ui: {
    signals: {
      "enclosure.status": (payload, ui) => {
        ui.setStatus(String(payload.text ?? ""));
      }
    }
  }
}

// Port definition
contributions: {
  port: {
    name: "enclosure",
    eventPattern: "command/enclosure.",
    cardinality: "zero-or-one"
  }
}
```

**Space Backends:**
- **OverlaySpace** - fuse-overlayfs (Linux only)
- **DockerSpace** - testcontainers (cross-platform)
- **StubSpace** - In-memory (tests)

**Confinement Options:**
```typescript
exec(command: string[], opts: {
  confine?: boolean,        // Linux namespaces (user+mount+pid+net)
  timeoutMs?: number,
  memoryMaxBytes?: number,  // cgroup memory limit
  cpuQuotaUs?: number       // cgroup CPU quota
})
```

**Lifecycle:**
- Session-scoped registry: `Map<spaceId, Space>`
- Cleanup on unmount: `for (const space of spaces.values()) space.destroy()`

---

### Domain 3: Agent Orchestration

#### **agent** - Delegation & Child Lifecycle
**Capabilities:**
- In-process delegation (`agent.run`)
- Process-isolated one-shot (`agent.run({ isolate: true })`)
- Async fire-and-forget (`agent.run({ async: true })`)
- Persistent child spawning (`agent.spawn`)
- Child prompting (`agent.ask`, `agent.converse`)
- Parallel racing (`agent.race`)
- Child management (`agent.kill`, `agent.list`, `agent.status`)
- Blue-green promotion (`agent.promote`)
- Model listing (`agent.models`)
- Task status (`agent.tasks`)

**Kernel Integration:**
```typescript
// Composite contribution system
const composite = createCompositeAgentRunContribution();

// Adapter lifecycle hooks
event: {
  "adapter.loaded": {
    handle: async (ctx) => {
      const contribution = ctx.payload.contributions?.["agent.run"];
      if (contribution) composite.add(name, contribution);
    }
  },
  "adapter.unloaded": {
    handle: async (ctx) => {
      composite.remove(ctx.payload.name);
    }
  }
}

// Tool schema extension
function buildRunTool(): ToolDefinition {
  return {
    name: "agent.run",
    inputSchema: z.object({
      ...RUN_BASE_SCHEMA,
      ...composite.mergedSchema()
    })
  };
}
```

**Strategy Resolution Cascade:**
```
1. Local strategies map (registered via registerStrategy)
2. Supervisor fallback (opts.supervisor?.strategy(name))
3. Global registry (execution framework)
```

**Profiles:**
- `explore` - Read-only (fs, grep, web)
- `general` - Full tools (writes enabled)
- `<child-name>` - Route to spawned process

**Design Patterns:**
- **Ad-hoc session factory** - Custom adapters/prompt/model per delegation
- **AsyncQueue** - Chunk streaming via async iterator
- **Relevance scoring** - `checkRelevance(text, reply)` for low-quality detection
- **Depth tracking** - `ALEF_AGENT_DEPTH` env var prevents infinite nesting

**Agent.run Flow:**
```
1. Profile resolution (explore | general | child-name)
2. Directive inheritance (opt-in via inheritDirectives)
3. Adapter materialization (opts.materializeAdapters)
4. Session creation (factory({ adapters, systemPrompt, model }))
5. Streaming execution (onChunk → AsyncQueue)
6. Relevance check (warn on low overlap)
```

**Child Lifecycle (Persistent):**
```
spawn({ blueprintPath }) → { name: <uuid>, ready: true }
ask({ name, prompt, maxMs }) → { reply: string }
converse({ name, prompts }) → { replies: string[] }
kill({ name }) → { killed: true }
```

---

#### **eval** - Response Scoring & Validation
**Capabilities:**
- Structural validators (deterministic)
- LLM-as-judge scoring (0-100)
- Transcript collection (SSE from child endpoint)
- Pass/fail threshold

**Kernel Integration:**
```typescript
// UI signals
contributions: {
  ui: {
    signals: {
      "eval.intent": (payload, ui) => {
        ui.setIntent(String(payload.text ?? ""));
      }
    }
  }
}
```

**Validator Types:**
```typescript
type Validator =
  | { type: "contains", value: string }
  | { type: "not_contains", value: string }
  | { type: "tool_called", value: string }
  | { type: "exit_code", value: string };
```

**Execution Flow:**
```
1. Send prompts sequentially to child endpoint
2. Collect SSE transcript events
3. Phase 1: Run structural validators (fast-fail)
4. Phase 2: LLM-as-judge (if judgeRubric provided)
5. Return { passed, score, failures, reasoning, transcript }
```

**LLM Judge Protocol:**
```
Prompt:
  "Rubric: <rubric>
   Transcript: <events>
   
   Respond with:
   Score: <0-100>
   Reasoning: <one sentence>"

Parse output:
  /Score:\s*(\d+)/i
  /Reasoning:\s*(.+)/i
```

**Use Case:**
```
supervisor.spawn({ blueprintPath: "adapter.yaml" })
  → { endpoint: "http://localhost:PORT" }

eval.run({
  endpoint,
  prompts: [{ role: "user", text: "test the feature" }],
  validators: [{ type: "tool_called", value: "feature.use" }],
  judgeRubric: "Correctness: Did the agent use the right tool?",
  judgeThreshold: 70
})
  → { passed: true, score: 85, reasoning: "..." }
```

---

#### **meta** - Alef Introspection & Prototyping
**Capabilities:**
- Session queries (`alef.sessions.list`, `alef.sessions.search`, `alef.sessions.read`, `alef.sessions.rename`)
- Config inspection (`alef.config.get`, `alef.adapters.list`, `alef.pm.history`)
- Directive management (`alef.directive.list/enable/disable/toggle/replace/add/remove`)
- Adapter prototyping (`prototype.plug`, `prototype.unplug`, `prototype.list`)
- Blue-green rebuild (`alef.rebuild`)

**Kernel Integration:**
```typescript
// Worker thread isolation
function loadAdapterInWorker(adapterPath: string, cwd: string): Promise<Adapter> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_BOOTSTRAP, { workerData: { adapterPath, cwd } });
    
    worker.once("message", (msg: { type, name, tools, subscriptions }) => {
      if (msg.type !== "ready") return reject();
      
      // Proxy adapter - forwards command events to worker
      const proxyAdapter: Adapter = {
        name: msg.name,
        tools: msg.tools.map(t => ({
          name: t.name,
          inputSchema: passthroughSchema(t.jsonSchema)
        })),
        mount(bus) {
          const offs = msg.subscriptions.command.map(type =>
            bus.command.subscribe(type, event => {
              worker.postMessage({ dir: "command", event });
            })
          );
          worker.on("message", workerMsg => {
            if (workerMsg.dir === "event") {
              bus.event.publish(workerMsg.event);
            }
          });
          return () => {
            for (const off of offs) off();
            worker.terminate();
          };
        }
      };
      resolve(proxyAdapter);
    });
  });
}
```

**Prototype Validation:**
```typescript
const FORBIDDEN_CODE_PATTERNS = [
  { pattern: /process\.exit/, reason: "would terminate host agent" },
  { pattern: /child_process/, reason: "bypasses adapter isolation" },
  { pattern: /require\s*\(/, reason: "require() forbidden in ESM" },
  { pattern: /eval\s*\(/, reason: "executes arbitrary code" },
  { pattern: /Function\s*\(/, reason: "Function constructor forbidden" },
  { pattern: /import\s*\(\s*['"`](?!@dpopsuev\/alef)/, reason: "dynamic imports outside @dpopsuev/alef" }
];
```

**Prototyping Skill Book:**
```markdown
## Scaffold
Every adapter must follow this exact structure:

import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";

export function createAdapter() {
  return defineAdapter("namespace", {
    command: {
      "namespace.action": typedAction(TOOL, async (ctx) => {
        return withDisplay({ result }, { text, mimeType });
      })
    }
  }, {
    description: "...",
    directives: ["..."]
  });
}

## Iterate Loop
1. factory.adapter → write scaffold to ~/.alef/prototypes/<name>.ts
2. prototype.plug({ path }) → load into running agent
3. Call the new tool to verify
4. If it fails:
   a. fs.edit the file
   b. prototype.unplug({ name })
   c. prototype.plug({ path })
   d. Repeat from step 3
5. Maximum 5 iterations
```

---

#### **factory** - Adapter Scaffolding
**Capabilities:**
- Adapter scaffold generation (`factory.adapter`)
- Blueprint YAML generation (`factory.blueprint`)

**Kernel Integration:**
```typescript
// No special integrations - pure scaffolding utility
```

**Adapter Scaffold Template:**
```typescript
function buildAdapterScaffold(name, toolName, description, inputFields) {
  const namespace = toolName.split(".")[0];
  const fieldLines = Object.entries(inputFields)
    .map(([key, type]) => `\t\t\t${key}: z.${type}().describe(""),`)
    .join("\n");
  
  return `
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";

export function createAdapter() {
  const TOOL = {
    name: "${toolName}",
    description: "${description}",
    inputSchema: z.object({
${fieldLines}
    }),
  };

  return defineAdapter("${namespace}", {
    command: {
      "${toolName}": typedAction(TOOL, async (ctx) => {
        const { ${Object.keys(inputFields).join(", ")} } = ctx.payload;
        // TODO: implement
        return withDisplay(
          { ${Object.keys(inputFields).join(", ")} },
          { text: \`${toolName}: not yet implemented\`, mimeType: "text/plain" },
        );
      }),
    },
  }, {
    description: "${description}",
    directives: ["Use ${toolName} to ${description.toLowerCase()}."],
  });
}
`;
}
```

**Blueprint Template:**
```yaml
apiVersion: alef.dpopsuev.io/v1alpha1
kind: AgentRuntime
metadata:
  name: <name>
  annotations:
    description: <description>
spec:
  adapters:
    - name: fs       # Built-in
    - path: ./custom.ts  # Custom adapter
  model: claude-haiku-4-5
```

**Output Paths:**
- Adapters: `~/.alef/prototypes/<name>.ts`
- Blueprints: `~/.config/alef/agents/<name>.yaml`

---

### Domain 4: Web & External Data

#### **web** - HTTP Fetch & Search
**Capabilities:**
- Page fetching (`web.fetch`)
- Web search (`web.search`)
- Multi-format support (markdown, lean, html)
- Multi-engine fallback (Brave → Tavily → Exa → DDG)

**Kernel Integration:**
```typescript
// Port definition
contributions: {
  port: {
    name: "web",
    eventPattern: "command/web.",
    cardinality: "zero-or-one"
  }
}

// Event weights
"event.weights": { "web.fetch": 0.9 }

// History tracking
history: {
  ownedTools: ["web.fetch", "web.search"],
  extractEntry: (payload) => {
    const url = payload.url;
    const query = payload.query;
    return url ? { url } : query ? { query } : null;
  }
}
```

**Spider Integration:**
```typescript
// Uses @dpopsuev/web-spider for Readability + Turndown
const page = await spider(url, {
  timeoutMs,
  tokenBudget,
  view: format === "lean" ? "lean" : "full"
});

// Session-scoped LRU cache
const cache = new SpiderCache({ maxSize: 50, ttlMs: 30 * 60 * 1000 });
```

**Search Engine Fallback:**
```typescript
function buildSearchEngine(engineName?: string): ISearchEngine {
  if (engineName) {
    // Explicit engine selection
    return { brave, tavily, exa, ddg }[engineName];
  }
  
  // Auto-fallback chain
  const engines = [];
  if (process.env.BRAVE_SEARCH_API_KEY) engines.push(new BraveSearchEngine(...));
  if (process.env.TAVILY_API_KEY) engines.push(new TavilySearchEngine(...));
  if (process.env.EXA_API_KEY) engines.push(new ExaSearchEngine(...));
  engines.push(new DdgSearchEngine()); // Always available
  
  return new FallbackSearchEngine(engines);
}
```

**Format Options:**
- `markdown` (default) - Readability article extraction + Turndown
- `lean` - Headings + body links only (triage)
- `html` - Raw HTML (structure-sensitive pages)

---

#### **mcp-registry** - MCP Discovery & Loading
**Capabilities:**
- Registry search (`mcp.search`)
- MCP server installation (`mcp.install`)
- List loaded servers (`mcp.list`)

**Kernel Integration:**
```typescript
// Dynamic adapter loading
"mcp.install": typedAction(INSTALL_TOOL, async (ctx) => {
  const { serverName, transport, config } = ctx.payload;
  
  let adapter: Adapter;
  if (transport === "stdio") {
    adapter = await McpAdapter.stdio(
      config.command ?? "npx",
      config.args ?? ["-y", serverName],
      serverName
    );
  } else {
    adapter = await McpAdapter.http(config.url, serverName);
  }
  
  loadedAdapters.set(serverName, adapter);
  if (opts.agent) {
    opts.agent.load(adapter); // Dynamic agent adapter injection
  }
  
  return { serverName, toolCount: adapter.tools.length, tools: adapter.tools };
})
```

**Registry API:**
```typescript
// Search endpoint
GET https://registry.modelcontextprotocol.io/v0/servers?search={query}&limit={limit}

// Response shape
interface RegistryResponse {
  servers: Array<{
    server: {
      name: string;
      description: string;
      version: string;
      repository?: { url: string; source: string };
      packages?: Array<{
        registryType: string;  // "npm"
        identifier: string;     // "@org/package"
        transport: { type: string; url?: string };
        runtimeHint?: string;  // "node"
      }>;
    };
    _meta?: {
      "io.modelcontextprotocol.registry/official"?: {
        status: string;        // "stable"
        publishedAt: string;
        isLatest: boolean;
      };
    };
  }>;
}
```

**Transport Types:**
- `stdio` - npx command execution (default: `npx -y <serverName>`)
- `http` - Remote MCP server (requires `config.url`)

---

### Domain 5: Planning & Workflow

#### **plan** - Phased Planning
**Capabilities:**
- 11-phase lifecycle (intention → inception → contraction → fixation → expansion → reduction → consolidation → implementation → assessment → refinement → introspection)
- Node graph with parent/child hierarchy
- State tracking (pending, active, done, deferred)
- After-action review (AAR)

**Kernel Integration:**
```typescript
// Context assembly - auto-inject plan into system prompt
contributions: {
  "context.assemble": async (input) => {
    const plan = loadOrCreate();
    if (!plan || plan.phase === "closed") return {};
    const summary = plan.renderSummary();
    return {
      messages: injectContextBlock(
        input.messages,
        `[Plan — ${plan.phase}]\n${summary}`
      )
    };
  }
}

// UI signals
ui: {
  signals: {
    "plan.intent": (payload, ui) => {
      ui.setIntent(String(payload.text ?? ""));
    },
    "plan.tree": (payload, ui) => {
      ui.setWidgetAbove(String(payload.tree ?? ""));
    }
  }
}
```

**Phase Transitions:**
```
begin → state → exclude → fix → expand → reduce → consolidate → checkpoint → assess → complete → close
```

**Node Operations:**
- `plan.expand({ nodes: [{ label, parent? }] })` - Add work nodes
- `plan.reduce({ prune: [nodeId] })` - Remove unnecessary nodes
- `plan.checkpoint({ nodeId })` - Mark node active
- `plan.assess({ nodeId, result })` - Record execution outcome
- `plan.refine({ nodeId, feedback })` - Send back for rework
- `plan.complete({ nodeId })` - Mark done

**Persistence:**
- JSON file: `{sessionDir}/plan.json`
- Loaded on mount, saved after each mutation

---

#### **workflow** - Contract-Based Validation Pipelines
**Capabilities:**
- Multi-station execution (`workflow.run`)
- Contract validation (Zod schemas)
- Human-in-the-loop (HITL) gates
- Question/answer logging

**Kernel Integration:**
```typescript
// Workflow definition
interface WorkflowDef {
  name: string;
  stations: StationDef[];
  start: string;  // Initial station name
  done: string;   // Final station name
}

interface StationDef {
  name: string;
  goal: string;
  contract: Contract<z.ZodSchema>;
  budget: { turns: number; tokens: number };
}

// Contract tool
defineAdapter("contract", {
  command: {
    "contract.submit": typedAction(SUBMIT_TOOL, async (ctx) => {
      // 1. Zod schema validation
      const schemaResult = contract.schema.safeParse(ctx.payload.data);
      if (!schemaResult.success) return { success: false, errors };
      
      // 2. Optional HITL validation
      if (contract.validator) {
        const id = newCorrelationId();
        command.publish({ type: VALIDATE_REQUEST, payload: { id, output, kind, context } });
        
        // Wait for VALIDATE_RESULT with 5s auto-approve timeout
        const approved = await waitForValidation(id, AUTO_APPROVE_MS);
        if (!approved) return { success: false, errors: feedback };
      }
      
      // 3. Fulfill
      onSubmit(validated);
      return { success: true };
    })
  }
})
```

**Station Execution:**
```typescript
interface StationRunner {
  run(station: StationDef, artifact: unknown): Promise<StationResult>;
}

interface StationResult {
  status: "fulfilled" | "budget_exhausted" | "error";
  output: unknown;
  questions: Array<{ question: string; answer: string }>;
}
```

**Question Tool:**
```typescript
defineAdapter("question", {
  command: {
    "question.ask": typedAction(QUESTION_TOOL, async (ctx) => {
      const question = ctx.payload.question;
      const answer = await onQuestion(question);  // Blocks until user responds
      log.push({ question, answer });
      return { answer };
    })
  }
})
```

**HITL Validation Flow:**
```
1. Agent calls contract.submit(data)
2. Adapter publishes VALIDATE_REQUEST event
3. External evaluator (supervisor/human UI) subscribes to VALIDATE_REQUEST
4. Evaluator publishes VALIDATE_RESULT(id, approved, feedback)
5. Adapter resolves promise with approval decision
6. If no response within 5s, auto-approve
```

---

### Domain 6: Knowledge & Context

#### **skills** - Skill Library
**Capabilities:**
- List skill books (`skills.books`)
- List filesystem skills (`skills.list`)
- Load single page (`skills.invoke`)
- Load full book (`skills.open`)

**Kernel Integration:**
```typescript
// Adapter contribution registry
event: {
  "adapter.loaded": {
    handle: async (ctx) => {
      const books = ctx.payload.contributions?.skills ?? [];
      if (books.length > 0) mergeBooks(name, books);
    }
  },
  "adapter.unloaded": {
    handle: async (ctx) => {
      removeAdapter(ctx.payload.name);
    }
  }
}

// Agent.run contribution - playbook selection
contributions: {
  "agent.run": {
    schema: {
      playbook: z.string().optional().describe("Named skill library playbook")
    },
    extend(args, context) {
      const playbook = args.playbook;
      if (!playbook) return;
      const book = library.get(playbook);
      if (!book) return;
      context.prependInstructions(
        book.pages.map(p => `## ${p.name}\n\n${p.instructions}`).join("\n\n")
      );
    }
  }
}
```

**Skill Discovery:**
```typescript
// Standard paths (agentskills.io convention)
const SKILL_PATHS = [
  "{cwd}/.alef/skills",
  "~/.config/alef/skills",
  "/usr/local/share/alef/skills"
];

// SKILL.md format
---
name: skill-name
description: One sentence
userInvocable: true
disableModelInvocation: false
---

# Skill Instructions

Markdown content...
```

**Library Composition:**
```typescript
// Adapter-registered books
const adapterBooks = new Map<string, SkillBook[]>();

// Merge on adapter.loaded
function mergeBooks(adapterName: string, books: SkillBook[]) {
  adapterBooks.set(adapterName, books);
  rebuildLibrary();  // Union of all adapter contributions
}
```

**SkillBook Structure:**
```typescript
interface SkillBook {
  name: string;
  description: string;
  pages: SkillPage[];
}

interface SkillPage {
  name: string;
  description: string;
  instructions: string;
}
```

---

#### **discourse** - Multi-Agent Forum
**Capabilities:**
- Post to forum topics/threads (`discourse.post`)
- Read thread posts (`discourse.read`)
- List topics/threads (`discourse.list`)

**Kernel Integration:**
```typescript
// Context assembly - auto-inject new posts
contributions: {
  "context.assemble": async (input) => {
    const newPosts = store.readNewPosts(lastReadTs);
    if (newPosts.length === 0) return {};
    
    lastReadTs = Math.max(...newPosts.map(p => p.timestamp));
    const block = `[Forum — ${newPosts.length} new post(s)]\n${newPosts.map(formatContextPost).join("\n")}`;
    
    return { messages: injectContextBlock(input.messages, block) };
  }
}
```

**Storage Backend:**
```typescript
class DiscourseStore {
  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
  }
  
  append(topic: string, thread: string, author: string, content: unknown): Post {
    const post = { topic, thread, author, content, timestamp: Date.now() };
    const path = join(this.sessionDir, "discourse", topic, `${thread}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(post) + "\n");
    return post;
  }
  
  readThread(topic: string, thread: string, since?: number): Post[] {
    const path = join(this.sessionDir, "discourse", topic, `${thread}.jsonl`);
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    const posts = lines.map(line => JSON.parse(line));
    return since ? posts.filter(p => p.timestamp > since) : posts;
  }
}
```

**Use Case:**
Multi-agent coordination via pull-based message board:
```
Agent A: discourse.post({ topic: "findings", thread: "security", content: { issue: "..." } })
Agent B: discourse.read({ topic: "findings", thread: "security" })
  → [{ author: "A", content: { issue: "..." }, timestamp: 1234 }]
```

---

### Domain 7: Development Tools

#### **git** - Git & Forgejo Integration
**Capabilities:**
- Git status (`git.status`)
- Create pull request (`git.pr-create`)
- List pull requests (`git.pr-list`)
- Add PR review (`git.pr-review`)
- Merge pull request (`git.pr-merge`)

**Kernel Integration:**
```typescript
// Forgejo API client
async function forgeApi(opts, method, path, body?) {
  const url = `${opts.forgeUrl}/api/v1${path}`;
  const headers = { "Content-Type": "application/json" };
  if (opts.forgeToken) headers.Authorization = `token ${opts.forgeToken}`;
  
  const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Forge API ${method} ${path}: ${res.status}`);
  return res.json();
}
```

**Environment:**
- `ALEF_FORGE_URL` - Local Forgejo instance (default: `http://localhost:3000`)
- `ALEF_FORGE_TOKEN` - API token

**PR Workflow:**
```
1. git.status() → check working tree
2. shell.exec("git checkout -b feature")
3. <make changes>
4. shell.exec("git add . && git commit -m 'feat: ...'")
5. shell.exec("git push origin feature")
6. git.pr-create({ repo: "owner/repo", title, head: "feature", base: "main" })
7. git.pr-review({ repo, number, body: "LGTM", event: "APPROVED" })
8. git.pr-merge({ repo, number, method: "squash" })
```

---

## Kernel Integration Patterns

### 1. **Event-Driven Architecture**

```typescript
// Three bus channels
interface Bus {
  command: Channel;    // Tool invocation
  event: Channel;      // Domain events
  notification: Channel; // Out-of-band signals
}

// Subscription API
const off = bus.command.subscribe("fs.read", (event) => {
  const { correlationId, payload } = event;
  // Handle tool call
});
```

**Event Types:**
- `adapter.loaded` - Announce adapter boot (tools, contributions)
- `adapter.unloaded` - Cleanup on adapter removal
- `llm.response` - Agent turn completion (supervisor uses for child readiness)
- `task.progress`, `task.completed`, `task.failed` - Async agent.run events
- `VALIDATE_REQUEST`, `VALIDATE_RESULT` - Workflow HITL gates

---

### 2. **Tool Definition**

```typescript
// Zod-validated schema
const TOOL = {
  name: "namespace.action",
  description: "One sentence: what this tool does.",
  inputSchema: z.object({
    param: z.string().min(1).describe("Parameter documentation"),
  }),
  longRunning: true  // Optional: UI hint for progress indication
};

// Handler registration
command: {
  "namespace.action": typedAction(TOOL, async (ctx) => {
    const { param } = ctx.payload;
    return withDisplay(
      { result: param },  // Structured output (for LLM)
      { text: `Done: ${param}`, mimeType: "text/plain" }  // Display (for user)
    );
  })
}
```

**Display Modes:**
- `withDisplay(data, display)` - Dual output (LLM sees data, user sees display)
- `withLlmContent(content, metadata, display)` - Large content (web.fetch, code.read)

**Tool Options:**
```typescript
typedAction(TOOL, handler, {
  shouldCache: () => true,  // Cache responses (LSP queries)
  invalidates: () => ["fs.read", "fs.grep"]  // Clear cache on write
})
```

---

### 3. **Context Assembly**

Inject data into system prompt before LLM inference:

```typescript
contributions: {
  "context.assemble": async (input) => {
    const messages = [...input.messages];
    const systemIdx = messages.findIndex(m => m.role === "system");
    
    if (systemIdx >= 0) {
      const sys = messages[systemIdx];
      messages[systemIdx] = {
        ...sys,
        content: `${sys.content}\n\n${contextBlock}`
      };
    }
    
    return { messages };
  }
}
```

**Use Cases:**
- **Plan adapter** - Inject current plan tree
- **Discourse adapter** - Inject new forum posts
- **Scribe adapter** - Inject knowledge base summary

---

### 4. **UI Signals**

Push state to TUI/GUI via notification bus:

```typescript
contributions: {
  ui: {
    signals: {
      "adapter.intent": (payload, ui) => {
        ui.setIntent(String(payload.text ?? ""));
      },
      "adapter.status": (payload, ui) => {
        ui.setStatus(String(payload.text ?? ""));
      },
      "adapter.tree": (payload, ui) => {
        ui.setWidgetAbove(String(payload.tree ?? ""));
      }
    }
  }
}

// Emit from adapter
bus.notification.publish({
  type: "adapter.intent",
  payload: { text: "current task" },
  correlationId: ""
});
```

**Signal Types:**
- `intent` - Current task/focus (displayed in TUI status line)
- `status` - Adapter state (e.g. "enclosure: space-abc123")
- `tree` - Visual widget (plan tree, workflow DAG)

---

### 5. **Port System**

Declare exclusive event ownership:

```typescript
contributions: {
  port: {
    name: "filesystem",
    eventPattern: "command/fs.",
    cardinality: "zero-or-one"  // Only one fs adapter per agent
  }
}
```

**Cardinality:**
- `zero-or-one` - Singleton (fs, shell, web)
- `zero-or-more` - Multiple instances allowed (agent, skills)

---

### 6. **Event Weights**

Influence prompt selection in reasoning loop:

```typescript
contributions: {
  "event.weights": {
    "fs.write": 2.0,   // High-impact write
    "fs.edit": 2.0,
    "fs.read": 1.0,    // Standard read
    "shell.exec": 1.5, // Elevated (side effects)
    "fs.grep": 0.6,    // Low-impact query
    "web.fetch": 0.9
  }
}
```

**Weight Semantics:**
- `> 1.5` - Write/mutation operations
- `1.0` - Standard operations
- `< 1.0` - Read-only/query operations

---

### 7. **Lifecycle Hooks**

```typescript
{
  // Async initialization (LSP boot, database warmup)
  ready: async () => {
    await backend.warmUp();
  },
  
  // Mount - subscribe to events, start background processes
  mount: (bus: Bus) => {
    const off = bus.command.subscribe("tool.name", handler);
    return () => {
      off();
      // Cleanup - kill processes, close connections
    };
  },
  
  // Unmount callback from mount()
  onUnmount: () => {
    backend.stopLsp();
  }
}
```

---

### 8. **Contribution System**

Extend agent.run and other adapters:

```typescript
// Agent.run extension schema
contributions: {
  "agent.run": {
    schema: {
      playbook: z.string().optional()
    },
    extend(args, context) {
      if (args.playbook) {
        context.prependInstructions(playbookContent);
      }
    }
  }
}

// Composite merging (skills adapter)
const composite = createCompositeAgentRunContribution();
composite.add("adapter-name", contribution);
const mergedSchema = composite.mergedSchema();
```

---

### 9. **Cache Scopes**

Query-level caching for expensive operations:

```typescript
// FsRuntime - owns cache instances
class FsRuntime {
  private readonly caches = new Map<FsCacheScope, ToolResultCache>();
  
  getCache(scope: "grep" | "find" | "ls"): ToolResultCache {
    return this.caches.get(scope) ?? new InMemoryToolResultCache();
  }
}

// Adapter use
async function handleGrep(ctx, opts: FsAdapterOptions) {
  const cache = opts.runtime?.getCache("grep");
  return executeGrepQuery(input, { cwd, cache });
}
```

---

### 10. **Streaming Actions**

Yield chunks during long-running operations:

```typescript
typedStreamAction(SHELL_EXEC_TOOL, async function* (ctx) {
  const child = spawn(command, args);
  
  for await (const buf of pushQueue<Buffer>((push, done) => {
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("close", done);
  })) {
    yield { chunk: buf.toString("utf-8") };
  }
  
  yield withDisplay(
    { output, exitCode },
    { text: output, mimeType: "text/plain" }
  );
})
```

---

## Security & Isolation Models

### **OCAP (Object Capability) Model**

Adapters declare allowed paths explicitly:

```typescript
interface FsAdapterOptions {
  writableRoots?: readonly string[];  // Allowlist
}

function resolveFilePath(cwd: string, filePath: string, allowedRoots?: readonly string[]): string {
  const abs = resolve(cwd, filePath);
  if (allowedRoots) {
    const allowed = allowedRoots.some(root => 
      abs.startsWith(root) || abs === root
    );
    if (!allowed) throw new Error(`Path '${filePath}' resolves outside allowed roots`);
  }
  return abs;
}
```

---

### **Sandbox Isolation**

**Nodesh** - VM context isolation:
```typescript
const sandbox = {
  require: makeSandboxedRequire(allowlist),
  console: { log, error, warn },
  process: { cwd: () => opts.cwd, env, platform }
};
const context = vm.createContext(sandbox);
vm.runInContext(code, context, { timeout });
```

**Enclosure** - Linux namespaces + cgroups:
```typescript
exec(command, {
  confine: true,           // user+mount+pid+net namespaces
  memoryMaxBytes: 1024e6,  // 1GB cgroup limit
  cpuQuotaUs: 50_000       // 50% CPU quota
})
```

---

### **Guard Rules**

Structural enforcement prevents unsafe patterns:

```typescript
const DEFAULT_GUARD_RULES = [
  {
    test: (cmd) => /git.*--no-verify/.test(cmd),
    reason: "Pre-commit hooks are mandatory"
  },
  {
    test: (cmd) => /git reset --hard/.test(cmd),
    reason: "Use git checkout <file> instead"
  }
];

// Pre-execution check
const guard = guardCommand(command, rules);
if (guard.blocked) throw new Error(guard.reason);
```

---

### **Read-Before-Edit Enforcement**

FileTracker prevents blind edits:

```typescript
class FileTracker {
  private readonly readTimes = new Map<string, number>();
  
  record(path: string): void {
    this.readTimes.set(path, Date.now());
  }
  
  lastReadAt(path: string): number | undefined {
    return this.readTimes.get(path);
  }
}

// In edit handler
const lastReadAt = tracker.lastReadAt(absolutePath);
if (lastReadAt === undefined) {
  throw new Error("File has not been read this session. Use fs.read first.");
}

const mtimeMs = (await stat(absolutePath)).mtimeMs;
if (mtimeMs > lastReadAt) {
  throw new Error("File was modified after you last read it. Re-read before editing.");
}
```

---

## Adapter Composition Patterns

### **1. Backend Abstraction**

CodeIntelAdapter uses pluggable backends:

```typescript
export interface CodeIntelBackend {
  workspaceSymbols(query: string): Promise<Symbol[]>;
  getHover(path: string, line: number, character: number): Promise<Hover | null>;
  callers(symbol: string, opts?: { path?: string }): Promise<Caller[]>;
  getDiagnostics(path: string): Promise<Diagnostic[]>;
}

// Implementations
class LocalCodeIntelBackend implements CodeIntelBackend { ... }
class StubCodeIntelBackend implements CodeIntelBackend { ... }
class DockerCodeIntelBackend implements CodeIntelBackend { ... }

// Adapter construction
const backend = opts.backend ?? new LocalCodeIntelBackend({ cwd, writableRoots });
```

---

### **2. MCP Bridge Pattern**

Locus/Scribe use identical MCP proxy pattern:

```typescript
mount(bus: Bus): () => void {
  const bootPromise = McpAdapter.stdio(binary, args, name, env)
    .then(mcpAdapter => {
      inner = mcpAdapter;
      
      // Dynamic tool registration
      adapter.tools = mcpAdapter.tools;
      adapter.subscriptions.command = mcpAdapter.tools.map(t => t.name);
      
      innerCleanup = mcpAdapter.mount(bus);
      
      // Announce to kernel
      bus.event.publish({
        type: "adapter.loaded",
        payload: { name, tools: [...] }
      });
    });
  
  return () => {
    innerCleanup?.();
    if (inner && "close" in inner) inner.close();
  };
}
```

---

### **3. Worker Thread Proxy**

Meta adapter isolates prototype adapters:

```typescript
// Main thread - proxy adapter
const proxyAdapter: Adapter = {
  name: msg.name,
  tools: msg.tools.map(t => ({
    name: t.name,
    inputSchema: passthroughSchema(t.jsonSchema)
  })),
  mount(bus) {
    // Forward command events to worker
    const offs = msg.subscriptions.command.map(type =>
      bus.command.subscribe(type, event => {
        worker.postMessage({ dir: "command", event });
      })
    );
    
    // Forward worker events to bus
    worker.on("message", workerMsg => {
      if (workerMsg.dir === "event") {
        bus.event.publish(workerMsg.event);
      }
    });
    
    return () => {
      for (const off of offs) off();
      worker.terminate();
    };
  }
};

// Worker thread - bootstrap.ts
const adapter = await loadAdapter(adapterPath, cwd);
const bus = createWorkerBus();
adapter.mount(bus);

// Send ready signal
parentPort.postMessage({
  type: "ready",
  name: adapter.name,
  tools: adapter.tools.map(serializeToolDef),
  subscriptions: adapter.subscriptions
});
```

---

### **4. Composite Contribution**

Skills adapter aggregates contributions from all adapters:

```typescript
// Central registry
const adapterBooks = new Map<string, SkillBook[]>();

// Event handlers
event: {
  "adapter.loaded": {
    handle: async (ctx) => {
      const books = ctx.payload.contributions?.skills ?? [];
      if (books.length > 0) mergeBooks(ctx.payload.name, books);
    }
  },
  "adapter.unloaded": {
    handle: async (ctx) => {
      removeAdapter(ctx.payload.name);
    }
  }
}

// Rebuild merged library
function rebuildLibrary() {
  library.clear();
  for (const contribution of adapterBooks.values()) {
    for (const book of contribution) {
      const existing = library.get(book.name);
      library.set(book.name, existing 
        ? { ...existing, pages: [...existing.pages, ...book.pages] }
        : book
      );
    }
  }
}
```

---

## Adapter Dependency Graph

```
agent (delegation)
  ├─> fs (read blueprints)
  ├─> shell (spawn child processes)
  └─> supervisor (strategy resolution)

code-intel (LSP intelligence)
  └─> fs (file I/O delegate)

shell (command execution)
  └─> pty-manager (optional PTY sessions)

enclosure (isolated workspaces)
  └─> docker (optional testcontainers)

web (HTTP/search)
  └─> @dpopsuev/web-spider (Readability + Turndown)

mcp-registry (MCP discovery)
  └─> @dpopsuev/alef-kernel/mcp (McpAdapter.stdio/http)

locus (architecture analysis)
  └─> @dpopsuev/alef-kernel/mcp (McpAdapter.stdio)

scribe (work graph)
  └─> @dpopsuev/alef-kernel/mcp (McpAdapter.stdio)

plan (phased planning)
  └─> (no external deps)

workflow (contract validation)
  └─> (no external deps)

skills (skill library)
  └─> fs (SKILL.md discovery)

discourse (multi-agent forum)
  └─> fs (JSONL persistence)

meta (introspection)
  ├─> fs (session JSONL reading)
  └─> worker_threads (prototype isolation)

factory (scaffolding)
  └─> fs (write prototypes)

eval (response scoring)
  └─> @dpopsuev/alef-ai/stream (LLM-as-judge)

git (Forgejo integration)
  └─> fetch (Forgejo API)

nodesh (JavaScript REPL)
  └─> vm (sandboxed execution)
```

---

## Key Architectural Insights

### **1. Separation of Concerns**

- **Adapters** own domain logic
- **Kernel** owns bus/lifecycle/composition
- **Runtime/Services** own stateful backends (LSP, cache, space)

### **2. Event-Driven Composition**

- Adapters discover each other via `adapter.loaded` events
- No compile-time coupling between adapters
- Skills/discourse inject context via `context.assemble`

### **3. Capability-Based Security**

- OCAP model: `writableRoots` allowlists
- Sandbox isolation: VM contexts, Linux namespaces
- Guard rules: structural pattern blocking

### **4. Streaming-First**

- `shell.exec` yields chunks as they arrive
- `agent.run` streams LLM tokens via AsyncQueue
- Push-queue pattern converts Node.js events → async iterables

### **5. Cache Coherency**

- **Write invalidates** - `fs.write` clears `fs.read` cache
- **Scope isolation** - grep/find have separate cache instances
- **Optional caching** - `shouldCache: () => true` per tool

### **6. Dual Output Model**

- `withDisplay(data, display)` - LLM sees structured data, user sees formatted text
- Enables rich TUI/GUI while preserving LLM-friendly JSON

### **7. Lifecycle Contracts**

```typescript
// Construction - no I/O
const adapter = createAdapter({ cwd, ... });

// Readiness - async I/O (LSP boot, DB connection)
await adapter.ready?.();

// Mount - subscribe to events
const unmount = adapter.mount(bus);

// Unmount - cleanup
unmount();
```

### **8. Dynamic Adapter Loading**

- `mcp-registry` loads MCP servers at runtime
- `meta` prototypes new adapters in worker threads
- `agent` spawns child agents with custom adapter sets

### **9. UI Signal Protocol**

Adapters push state to presentation layer without coupling:

```typescript
// Adapter side
bus.notification.publish({ type: "plan.tree", payload: { tree } });

// UI side (TUI/GUI)
adapter.contributions.ui.signals["plan.tree"](payload, ui);
```

### **10. Contribution Extensibility**

Adapters extend other adapters via declarative contributions:

```typescript
// Skills adapter extends agent.run
contributions: {
  "agent.run": {
    schema: { playbook: z.string().optional() },
    extend(args, context) {
      if (args.playbook) {
        context.prependInstructions(playbookContent);
      }
    }
  }
}

// Agent adapter merges all contributions
const composite = createCompositeAgentRunContribution();
adapter.event["adapter.loaded"].handle = (ctx) => {
  const contribution = ctx.payload.contributions?.["agent.run"];
  if (contribution) composite.add(name, contribution);
};
```

---

## Conclusion

Alef's adapter architecture achieves:

✅ **Modularity** - 18 adapters, 7 domains, zero compile-time coupling  
✅ **Composability** - Dynamic loading, contribution system, event discovery  
✅ **Security** - OCAP, sandboxes, guard rules, read-before-edit  
✅ **Extensibility** - MCP bridge, worker isolation, runtime prototyping  
✅ **Performance** - Streaming, caching, scope isolation  
✅ **Observability** - Event weights, UI signals, structured logging  

The kernel provides **bus + lifecycle + composition primitives**. Adapters implement **domain capabilities** using those primitives. The result is a **capability-based orchestration framework** where:

1. **Tools** are the interface (LLM-callable functions)
2. **Adapters** are the implementation (domain logic + kernel integration)
3. **Bus** is the coordination layer (event-driven composition)
4. **Contributions** are the extension points (context assembly, UI signals, reasoning extensions)

This architecture enables Alef to support **heterogeneous tool ecosystems** (LSP, MCP, worker threads, child processes) while maintaining **coherent reasoning context** and **safe execution boundaries**.
