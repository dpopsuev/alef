# Agent Architecture Analysis

## Executive Summary

The Alef agent architecture is a **layered, composable system** built on three key abstractions:
1. **Agent Kernel** - The core runtime (bus-based adapter system)
2. **Blueprints** - Pluggable configurations that assemble adapters into specialized stacks
3. **Profiles** - Model selection and configuration templates

The architecture follows a **dependency injection** pattern where agents are assembled from adapters, and the assembly process is controlled by blueprints that define tool capabilities, context management strategies, and delegation patterns.

---

## 1. Agent Assembly Architecture

### 1.1 Core Components Hierarchy

```
Entrypoint (entrypoint.ts)
    ↓
Supervisor (manages lifecycle of services)
    ↓
┌─────────────────────┬──────────────────────┬──────────────────┐
│  StorageService     │  SessionService      │  AgentService    │
│  (persistence)      │  (core assembly)     │  (daemon mgmt)   │
└─────────────────────┴──────────────────────┴──────────────────┘
                              ↓
                      SessionHandle (runtime)
                              ↓
                      Agent + Controller
```

### 1.2 Assembly Flow (Session Service)

The **SessionService** (`session-service.ts`) is the heart of agent assembly. Here's the detailed flow:

```typescript
// 1. BOOTSTRAP PHASE
loadAdapters(args, cfg, log, sessionDir)
  → Discovers blueprint (YAML or TypeScript)
  → Materializes adapters from blueprint definition
  → Returns: { adapters, blueprintModelId, blueprintName, surfaces, writableRoots }

resolveStartupModel(args, blueprintModelId, cfg)
  → Resolves model from: CLI args > blueprint > config > auto-detect
  → Returns: Model<Api> object with contextWindow, API details

// 2. DIRECTIVE ASSEMBLY
createDefaultDirectives({ tools, cwd })
  → Registers core directives (identity, behavior, format, safety)
  → Loads workspace-specific directives (AGENTS.md, .alef/directives/*.md)
  → Registers adapter-contributed directives
  → Returns: Directives instance with priority-ordered system prompt blocks

// 3. BLUEPRINT STACK CREATION
blueprintRegistry.resolve(blueprintName)
  → Looks up factory function (e.g., createCodingAgentStack)
  → Factory receives: { cwd, model, sessionStore, domainAdapters, subagentFactory, writableRoots }
  → Returns: { adapters, pipeline }

// 4. AGENT KERNEL CONSTRUCTION
buildAgent({ llm, session, modelId, agentIdentity, onLoop, summaryWriter })
  → Creates Agent instance with bus
  → Loads core adapters: LLM, LoopGuard, SessionLog
  → Returns: Agent (ready for adapter loading)

// 5. ADAPTER LOADING
agent.load(adapter)  // For each adapter in stack
  → Validates port definitions (command/event subscriptions)
  → Calls adapter.mount(bus) to wire up subscriptions
  → Tracks unmount callbacks for disposal
  → Announces adapter.loaded to all adapters

// 6. CONTROLLER & HANDLE CREATION
AgentController(agent, { onReply })
  → Provides high-level send/receive API
  → Manages turn correlation and reply capture

SessionHandle({ state, model, thinkingState, controller, agent, directives, ... })
  → Wraps agent with runtime state management
  → Exposes: send, receive, subscribe, dispose
  → Handles model/thinking switches, turn limits
```

### 1.3 Key Assembly Functions

#### `assemble.ts` - Low-level Agent Server
```typescript
function assembleAgentServer(opts: AgentServerOptions): AgentServer
```
- Creates bare Agent instance
- Loads LLM adapter
- Creates tool shell (unified tool interface)
- Loads pipeline + domain adapters
- Returns: { agent, controller, observers }
- **Used by**: `subagent-factory.ts` for lightweight inner agents

#### `local-session.ts` - Full Session Assembly
```typescript
async function createLocalSession(args, cfg, log, store, loaded, model, storage, identity)
```
- Builds directive set with workspace integration
- Creates blueprint stack via registry
- Constructs LLM adapter with system prompt injection
- Builds agent kernel with session logging
- Loads blueprint adapters + meta adapter
- Wires up observers for event fan-out
- Returns SessionHandle (the Session interface)

#### `agent-kernel.ts` - Minimal Kernel
```typescript
function buildAgent(opts: AgentKernelOptions): Agent
```
- Creates Agent with bus
- Loads: LLM adapter, LoopGuard, SessionLog (optional)
- **Does NOT** load domain adapters (caller's responsibility)
- Minimal core for testing and subagents

---

## 2. Lifecycle Management

### 2.1 Startup Sequence

```
1. entrypoint.ts
   ├─ Parse args, load config, setup OTel
   ├─ Initialize YAML blueprints (scan ~/.alef/blueprints, .alef/blueprints)
   ├─ Create Supervisor
   └─ Register services (storage → session → agent → tui)

2. Supervisor.startAll()
   ├─ Start storage service (SQLite/KV stores)
   ├─ Start session service
   │  ├─ Load adapters (blueprint materialization)
   │  ├─ Build directives (system prompt assembly)
   │  ├─ Create blueprint stack
   │  ├─ Build agent kernel
   │  ├─ Load all adapters
   │  ├─ Validate ports
   │  └─ Call agent.ready()
   ├─ Start agent service (daemon registration if --daemon)
   └─ Start TUI service (ViewMode selection)

3. agent.ready()
   ├─ Calls ready() on all adapters
   └─ Adapters can perform async initialization (e.g., spawn processes)

4. ViewMode.run(session)
   ├─ Interactive: TUI input loop
   ├─ Print/JSON: Direct send() → stdout
   └─ Daemon: HTTP surface + block forever
```

### 2.2 Turn Lifecycle

```
User Input
    ↓
SessionHandle.send(text, timeout)
    ↓
AgentController.send(text, role, timeout)
    ↓
agent.bus.publish("event", { type: "llm.input", payload: { text, role } })
    ↓
Pipeline Stages (in order):
  1. memory stage (inject context from session store)
  2. compactor stage (summarize old turns if token budget exceeded)
  3. ... (custom stages from blueprint)
    ↓
LLM Adapter receives prepared messages
    ↓
┌─────────────────────────────────────────────┐
│  LLM Loop (reasoner package)                │
│  ├─ Stream chunks (llm.chunk signals)       │
│  ├─ Tool calls (llm.tool-start/end events)  │
│  ├─ Token usage (llm.token-usage signal)    │
│  └─ Final response (llm.response command)   │
└─────────────────────────────────────────────┘
    ↓
AgentController captures reply
    ↓
SessionHandle observers notified (UI updates)
    ↓
TurnComplete event → SessionLog → write to store
```

### 2.3 Disposal & Cleanup

```
SIGTERM/SIGINT
    ↓
Supervisor.stopAll()
    ↓
Services stopped in reverse order:
  1. TUI service (viewer cleanup)
  2. Agent service (daemon unregister)
  3. Session service
     ├─ SessionHandle.dispose()
     │  └─ Agent.dispose()
     │     ├─ controller.abort() (cancels in-flight LLM)
     │     ├─ adapter.unmount() for each adapter
     │     └─ bus cleanup
     └─ Session store flush
  4. Storage service (close DB connections)
    ↓
OTel shutdown (flush traces)
```

---

## 3. Blueprint Integration

### 3.1 Blueprint Registry

Located in `packages/core/blueprint/src/registry.ts`:

```typescript
interface BlueprintFactory {
  (opts: BlueprintStackOptions): Promise<BlueprintStack>
}

class BlueprintRegistry {
  register(name: string, factory: BlueprintFactory, { isDefault?: boolean })
  resolve(name?: string): BlueprintFactory | undefined
  list(): string[]
}
```

**Registration Mechanism**:
1. **TypeScript Blueprints**: Import side-effect modules (e.g., `@dpopsuev/alef-coding-agent`)
   - Calls `blueprintRegistry.register("alef-coding-agent", createCodingAgentStack, { isDefault: true })`
2. **YAML Blueprints**: `init-yaml-blueprints.ts` scans directories at startup
   - Discovers: `~/.config/alef/agents`, `~/.alef/blueprints`, `.alef/blueprints`
   - Loads YAML → creates factory wrapper → registers dynamically

### 3.2 Blueprint Stack Structure

A blueprint factory returns:

```typescript
interface BlueprintStack {
  adapters: Adapter[]      // Full adapter set (domain + meta + pipeline)
  pipeline: ContextPipeline  // Message transformation pipeline
}
```

**Example: Coding Agent Blueprint** (`packages/profiles/coding/src/blueprint.ts`):

```typescript
export async function createCodingAgentStack(opts: BlueprintStackOptions) {
  // 1. Create delegation stack (multi-agent patterns)
  const { adapters, pipeline } = await buildDelegationStack({
    cwd: opts.cwd,
    factory: opts.subagentFactory,  // Injected by runner
    contextWindow: opts.model.contextWindow,
    domainAdapters: opts.domainAdapters,  // User's tools from YAML
    sessionStore: opts.sessionStore,
    writableRoots: opts.writableRoots,
    extraAdapters: [skillsAdapter, factoryAdapter],
    summarize: createLlmSummarizer(opts.model),
    adapters: { createAgentAdapter, createCompactionStage, createSessionContextStage },
  });

  // 2. Return fully wired stack
  return { adapters, pipeline };
}
```

### 3.3 Blueprint Resolution Flow

```
1. CLI: alef --blueprint my-agent
   ↓
2. loadAdapters(args, cfg, log)
   ├─ args.blueprint → resolveBlueprint(name, cwd)
   │  ├─ Check: .alef/blueprints/{name}.yaml
   │  ├─ Check: ~/.alef/blueprints/{name}.yaml
   │  └─ Return: absolute path or undefined
   ├─ OR: Interactive picker (if TTY and multiple blueprints)
   └─ materializeBlueprint(definition, { cwd, loggerFor, allowedTools, writableRoots })
      ↓
3. createLocalSession(args, cfg, log, store, loaded, model, storage, identity)
   ├─ blueprintRegistry.resolve(loaded.blueprintName)
   │  └─ Returns: createCodingAgentStack (or YAML wrapper)
   ├─ stackFactory({ cwd, model, subagentFactory, domainAdapters, ... })
   │  └─ Executes blueprint logic → returns { adapters, pipeline }
   └─ agent.load(adapter) for each adapter in stack
```

### 3.4 YAML Blueprint Auto-Loading

`init-yaml-blueprints.ts` bridges YAML definitions to runtime:

```typescript
async function initYamlBlueprints() {
  const yamlFiles = await discoverYamlBlueprints()  // Scan directories
  
  for (const yamlPath of yamlFiles) {
    const definition = loadAgentDefinition(yamlPath)
    const name = definition.resource?.metadata.name ?? definition.name
    
    // Create factory wrapper
    const factory = async (opts: BlueprintStackOptions) => {
      const { adapters } = await materializeBlueprint(definition, {
        cwd: opts.cwd,
        allowedTools: ['*'],
        writableRoots: opts.writableRoots,
      })
      const pipeline = createContextAssemblyPipeline()
      return { adapters, pipeline }
    }
    
    blueprintRegistry.register(name, factory)
  }
}
```

**YAML Blueprint Format**:
```yaml
apiVersion: alef.dev/v1beta1
kind: Agent
metadata:
  name: my-custom-agent
spec:
  model: anthropic/claude-sonnet-4-5
  adapters:
    - name: fs
      toolNames: [fs.read, fs.write, fs.edit]
    - name: web
      actions: []
  directives:
    - id: custom-behavior
      priority: 400
      content: |
        Custom instructions for this agent.
```

---

## 4. Profile Integration

### 4.1 Model Profiles (`model/profiles.ts`)

**Purpose**: Group models by provider/capability for easy switching.

```typescript
interface ModelProfile {
  name: string
  providers: string[]           // e.g., ["anthropic", "openai"]
  models?: string[]             // Filter: specific model IDs
  modelPatterns?: string[]      // Filter: regex patterns (e.g., "gpt-*")
  default?: string              // Default model ID for this profile
  tiers?: {
    strong?: string
    default?: string
    fast?: string
  }
}
```

**Config Example** (`config.yaml`):
```yaml
model: anthropic/claude-sonnet-4-5
profile: production

profiles:
  production:
    providers: [anthropic, openai]
    models: [claude-sonnet-4-5, gpt-4o]
    default: claude-sonnet-4-5
    tiers:
      strong: claude-opus-4-5
      default: claude-sonnet-4-5
      fast: claude-haiku-4-5
  
  local:
    providers: [ollama]
    default: llama3.3
```

### 4.2 Profile Resolution

```typescript
function resolveProfile(cfg: ModelConfig): ResolvedProfile | null
  ├─ Get profile name from cfg.profile
  ├─ Load profile definition from cfg.profiles[name]
  ├─ For each provider in profile.providers:
  │  └─ Filter models by profile.models or profile.modelPatterns
  └─ Return: { name, models: [{ provider, model }], defaultModel }

function resolveTier(cfg: ModelConfig, tier: ModelTier): string | undefined
  └─ Lookup profile.tiers[tier] → model ID
```

**Usage in Code**:
```typescript
// CLI tier selection (future feature)
alef --tier fast
  → Resolves to claude-haiku-4-5 (from profile.tiers.fast)

// Subagent optimization
agent.run(explore, { model: resolveTier(cfg, 'fast') })
  → Spawns cheap Haiku subagent for exploration
```

### 4.3 Model Resolution Precedence

```
1. CLI argument: --model anthropic/claude-sonnet-4-5
2. Blueprint model: definition.spec.model
3. Config file: config.yaml → model: ...
4. Profile default: cfg.profiles[cfg.profile].default
5. Auto-detect: First available API key → default model for that provider
6. Error: No model configured
```

Implemented in `model/resolve.ts`:

```typescript
function resolveStartupModel(args, blueprintModelId, cfg): Model<Api>
  ├─ Check: args.modelId (CLI flag)
  ├─ Check: blueprintModelId (from YAML spec.model)
  ├─ Check: cfg.model (config.yaml)
  ├─ Fallback: autoDetectModel()
  │  ├─ Scan env vars for API keys
  │  └─ Return default model for first detected provider
  └─ Error if none found

function buildModel(id: string): Model<Api>
  ├─ Parse: "provider/model-id"
  ├─ Lookup in catalog (getModels(provider))
  ├─ Fallback: Create synthetic model (for unknown IDs)
  └─ Return: Model<Api> with contextWindow, cost, API details
```

---

## 5. Directives System

### 5.1 Directive Structure

```typescript
interface Directive {
  id: string                     // Unique identifier
  priority: number               // Sort order (0 = first)
  content: string | (() => string)  // Static or dynamic content
  enabled: boolean
  tags?: string[]                // For filtering/grouping
  maxChars?: number              // Per-block budget limit
  meta?: Record<string, unknown> // Arbitrary metadata
}
```

### 5.2 Core Directives (Created by `createDefaultDirectives`)

| Priority | ID | Tags | Description |
|----------|-----|------|-------------|
| 0 | `core` | `identity`, `behavior`, `format`, `safety` | Agent identity, core guidelines |
| 5 | `reconciliation` | `behavior` | Conflict resolution patterns |
| 10 | `no-emojis` | `format` | Format restrictions |
| 15 | `no-files` | `behavior`, `safety` | Prevent unnecessary file creation |
| 100 | `tools` | `dynamic` | Available tool names |
| 200 | `guidelines` | `dynamic` | Tool usage guidelines |
| 450 | `agents-md` | `workspace`, `agents-md` | Project-level AGENTS.md content |
| 500 | `workspace.*` | `workspace` | Custom .alef/directives/*.md files |
| 600 | `adapter.*` | `adapter` | Adapter-contributed directives |
| 900 | `tool-shell.boot-catalog` | `adapter`, `dynamic` | Tool documentation (auto-generated) |
| 1000 | `environment` | `ephemeral` | Date, directory, PID, user info |

### 5.3 Directive Assembly & Rendering

```typescript
class Directives {
  register(directive: Directive): this
  enable(id: string), disable(id: string), toggle(id: string)
  
  resolve(): ResolvedDirective[]
    └─ Filters enabled=true, evaluates dynamic content functions
  
  build(budgetChars?: number): string
    ├─ resolve() → array of directives with static content
    ├─ budgetStrategy(directives, budget) → select directives fitting budget
    ├─ sort by comparator (default: priority ascending)
    └─ renderer(directives) → final string
}
```

**XML Renderer** (default):
```typescript
const xmlRenderer: DirectiveRenderer = (blocks) =>
  blocks.map((b) => `<${b.id}>\n${b.content}\n</${b.id}>`).join('\n\n')
```

Output:
```xml
<core>
You are Alef, a coding agent...
</core>

<no-emojis>
Never use emojis...
</no-emojis>

<tools>
- fs.read — Read file contents
- fs.edit — Apply exact text replacements
</tools>

<environment>
Date: 2026-06-27
Directory: /home/user/project
</environment>
```

### 5.4 Workspace Integration

**AGENTS.md Discovery**:
```typescript
async function loadWorkspace(directives: Directives, cwd: string) {
  // Try AGENTS.md, then agents.md
  for (const name of ['AGENTS.md', 'agents.md']) {
    try {
      const content = await readFile(join(cwd, name), 'utf-8')
      directives.register({
        id: 'agents-md',
        priority: 450,
        content: content.trim(),
        enabled: true,
        tags: ['workspace', 'agents-md'],
      })
      break
    } catch { /* file not found */ }
  }
  
  // Load .alef/directives/*.md
  const dir = join(cwd, '.alef', 'directives')
  const files = await readdir(dir)
  for (const file of files.filter(e => e.endsWith('.md')).sort()) {
    const content = await readFile(join(dir, file), 'utf-8')
    directives.register({
      id: `workspace.${file}`,
      priority: 500,
      content: content.trim(),
      enabled: true,
      tags: ['workspace'],
    })
  }
}
```

**Adapter Directives**:
```typescript
function registerAdapters(directives: Directives, adapters: Adapter[]) {
  for (const adapter of adapters) {
    if (!adapter.directives?.length) continue
    
    const header = adapter.description 
      ? `### ${adapter.name}: ${adapter.description}`
      : `### ${adapter.name}`
    const body = adapter.directives.join('\n\n')
    
    directives.register({
      id: `adapter.${adapter.name}`,
      priority: 600,
      content: `${header}\n\n${body}`,
      enabled: true,
      tags: ['adapter'],
    })
  }
}
```

---

## 6. Subagent & Delegation Architecture

### 6.1 Subagent Factory Pattern

**Purpose**: Create lightweight inner agents for delegation (explore, general, blueprint-specific).

**Factory Interface** (`blueprint/registry.ts`):
```typescript
type SubagentFactory = (opts: SubagentFactoryOptions) => SubagentSession

interface SubagentFactoryOptions {
  adapters: readonly Adapter[]         // Tool subset for this subagent
  onChunk?: (chunk: string) => void    // Stream LLM chunks to parent
  onInnerEvent?: (callId, type, payload) => void  // Bubble events
  systemPrompt?: string                // Custom instructions
  tokenBudget?: number                 // Soft limit (inject wrap-up message)
  modelOverride?: string               // Use cheaper model
}
```

**Implementation** (`subagent-factory.ts`):
```typescript
function buildSubagentFactory(opts: SubagentSessionOptions): SubagentFactory {
  return (callOpts) => {
    // 1. Generate subagent ID & identity (color, address)
    const subId = `${opts.parentSessionId}_${randomId()}`
    const subActor = resolveSubagentActor(parentSessionId, subId, boardId)
    
    // 2. Build system prompt (date + base + call-specific)
    const systemPrompt = [dateContext, opts.baseSystemPrompt, callOpts.systemPrompt]
      .filter(Boolean).join('\n\n')
    
    // 3. Create LLM adapter with prompt injection
    const llm = llmFactory({ model: resolvedModel, systemPrompt })
    
    // 4. Assemble agent server (minimal: LLM + adapters + pipeline)
    const { agent, controller, observers } = assembleAgentServer({
      llm, adapters: callOpts.adapters, pipeline, onReply: (text) => reply = text
    })
    
    // 5. Wire up event forwarding
    observers.add((event) => {
      if (event.type === 'token-usage') {
        // Track budget, inject wrap-up message if exceeded
        if (budgetExceeded) controller.receive('[system] Token budget reached...', 'system')
      }
      if (onChunk && event.type === 'chunk') onChunk(event.text)
      if (onInnerEvent) onInnerEvent(subId, event.type, payload)
    })
    
    // 6. Register in actor route table for @-mentions
    actorRoutes.register(subActor.color, async (message, timeout) => {
      await controller.send(message, 'human', timeout)
    })
    
    // 7. Return Session interface
    return new AgentSession({ state, send, receive, dispose, observers })
  }
}
```

### 6.2 Delegation Stack (`engine/delegation.ts`)

**Purpose**: Wire up multi-agent patterns (explore subagents, general subagents).

```typescript
async function buildDelegationStack(opts: DelegationStackOptions) {
  // 1. Materialize adapter sets for different agent profiles
  const [domainAdapters, { adapters: exploreAdapters }, { adapters: generalAdapters }] = 
    await Promise.all([
      opts.domainAdapters ?? materializeDefaultAdapters(cwd),
      materializeBlueprint({ adapters: DEFAULT_EXPLORE_ADAPTERS }, opts),  // Read-only tools
      materializeBlueprint(DEFAULT_COMPILED_DEFINITION, opts),             // Full toolset
    ])
  
  // 2. Create pipeline with memory + compaction stages
  const pipeline = createContextAssemblyPipeline()
  if (opts.sessionStore) {
    pipeline.addStage('memory', createSessionContextStage({ sessionStore, contextWindow }))
  }
  pipeline.addStage('compactor', createCompactionStage({ contextWindow, summarize }))
  
  // 3. Create delegation strategies
  const exploreStrategy = new InProcessStrategy(exploreAdapters, factory, EXPLORE_SYSTEM_PROMPT)
  const generalStrategy = new InProcessStrategy(generalAdapters, factory, GENERAL_SYSTEM_PROMPT)
  
  // 4. Create agent adapter (exposes agent.run tool)
  const agentAdapter = createAgentAdapter({
    strategies: { explore: exploreStrategy, general: generalStrategy },
    replyEvent: 'llm.response',
    writableRoots: opts.writableRoots,
    parentAdapterNames,
    allowedBlueprints: blueprintRegistry.list(),
    materializeAdapters,
    subagentFactory: factory,
  })
  
  // 5. Create tool shell (unified tool interface)
  const toolShell = createToolShellAdapter({
    tools: allAdapters.flatMap(o => o.tools),
    getTools: () => allAdapters.flatMap(o => o.tools),
    adapterDirectives: buildAdapterDirectives(allAdapters),
  })
  
  return { adapters: [...allAdapters, toolShell, pipeline], pipeline }
}
```

### 6.3 Agent.run Tool Flow

```
Parent Agent LLM
    ↓
Tool Call: agent.run(explore, { query: "find all TODO comments" })
    ↓
Agent Adapter (adapter-agent)
    ├─ Resolve strategy: "explore" → InProcessStrategy
    ├─ Get adapter subset: [fs, web] (read-only)
    ├─ Build system prompt: EXPLORE_SYSTEM_PROMPT + query
    └─ factory({ adapters, systemPrompt, onChunk, onInnerEvent })
        ↓
Subagent Session
    ├─ Creates lightweight Agent (no session log, no loop guard)
    ├─ send(query) → LLM processes with restricted tools
    ├─ Streams chunks → onChunk → parent UI updates
    ├─ Inner tool calls → onInnerEvent → parent sees nested activity
    └─ Returns final reply text
        ↓
Parent LLM receives tool result
    ↓
Continues turn with exploration findings
```

---

## 7. Key Architectural Patterns

### 7.1 Adapter-Based Composition
- **No monolithic agent class**: Agents are assembled from adapters
- **Adapters own seams**: Each adapter declares command/event subscriptions (ports)
- **Port validation**: System ensures exactly one adapter per required port (e.g., LLM)
- **Hot reload**: Adapters can be unloaded/reloaded without restarting

### 7.2 Event-Driven Bus Architecture
- **Three channels**: Command (request-response), Event (results), Notification (signals)
- **Correlation IDs**: Track tool calls across async boundaries
- **Payload validation**: Zod schemas enforce message contracts (test mode only)
- **Observable**: SessionHandle observers fan out events to UI layers

### 7.3 Pipeline Transformation
- **Staged processing**: Messages pass through pipeline stages before LLM
  1. Memory injection (recent history)
  2. Compaction (summarize old turns if budget exceeded)
  3. Custom stages (blueprints can add more)
- **Schema resolution**: Pipeline provides tool schemas to LLM adapter
- **Context window aware**: Compaction triggers based on token tracking

### 7.4 Blueprint-Driven Configuration
- **Separation of concerns**: Blueprints define "what tools", runner handles "how to assemble"
- **Pluggable**: Switch entire agent capability set by changing blueprint
- **Multi-format**: YAML (user-friendly) and TypeScript (programmable)
- **Registry pattern**: Runtime lookup by name, no compile-time coupling

### 7.5 Identity & Actor Routing
- **Color-based addressing**: Each agent/subagent gets a unique color (e.g., @crimson, @amber)
- **Route table**: Maps colors to send() functions for @-mention routing
- **Hierarchical**: Parent agents register routes for their subagents
- **Visual**: Colors displayed in TUI for multi-agent conversations

### 7.6 Supervisor-Based Lifecycle
- **Service descriptors**: Declare dependencies (e.g., agent depends on session)
- **Topological start**: Services boot in dependency order
- **Managed shutdown**: Supervisor.stopAll() reverses the order
- **Health checks**: Services can report degraded state

---

## 8. Integration Points

### 8.1 Blueprint ↔ Profile
```
Blueprint defines: Tools, delegation patterns, context strategy
Profile defines: Model selection, tier overrides

Integration:
1. Blueprint can suggest model: definition.spec.model
2. Profile can override: config.yaml → profile: production → tiers.default
3. Subagents can use tier: agent.run(explore, { model: resolveTier(cfg, 'fast') })
```

### 8.2 Directives ↔ Blueprints
```
Blueprints provide:
  - Base adapter set → adapter.directives[] auto-registered
  - Custom directives via stack.pipeline.addStage()

Directives provide:
  - System prompt rendering (budget-aware)
  - Workspace integration (AGENTS.md, .alef/directives/*.md)
  - Dynamic content (tool catalog, environment)

Integration:
  buildLlmAdapter({ systemPrompt: directives.build(budgetChars) })
```

### 8.3 Session ↔ Agent
```
SessionStore:
  - Persists: turns (messages), metadata, summary
  - Provides: session.append(event), session.turns()

Agent:
  - Consumes: pipeline.addStage('memory', sessionContextStage)
  - Produces: SessionLog adapter → writes turn events to store

Integration (bidirectional):
  SessionLog listens for:
    - llm.input → record user message
    - llm.response → record assistant reply
    - llm.token-usage → update metadata
  Pipeline reads:
    - session.turns() → inject recent history into LLM context
```

---

## 9. Example: Full Assembly Trace

**Command**: `alef --blueprint my-agent --model anthropic/claude-sonnet-4-5`

```
1. entrypoint.ts
   ├─ parseArgs() → { blueprint: 'my-agent', modelId: 'anthropic/claude-sonnet-4-5', cwd: '/project' }
   ├─ initYamlBlueprints() → scans .alef/blueprints/my-agent.yaml → registers factory
   └─ Supervisor.register(sessionService, agentService, tuiService)

2. Supervisor.startAll()
   └─ sessionService.create()
      ├─ loadAdapters(args, cfg, log)
      │  ├─ resolveBlueprint('my-agent', '/project') → '/project/.alef/blueprints/my-agent.yaml'
      │  ├─ loadAgentDefinition(yamlPath) → definition
      │  └─ materializeBlueprint(definition, { cwd, allowedTools, writableRoots })
      │     └─ Returns: { adapters: [fsAdapter, webAdapter, orchestrationAdapter] }
      │
      ├─ resolveStartupModel(args, blueprintModelId, cfg)
      │  └─ buildModel('anthropic/claude-sonnet-4-5')
      │     └─ Returns: Model<Api> { id, name, api: 'anthropic-messages', contextWindow: 200000, ... }
      │
      ├─ createDefaultDirectives({ tools: [...], cwd: '/project' })
      │  ├─ Register: core, reconciliation, no-emojis, no-files, tools, guidelines, environment
      │  ├─ loadWorkspace() → finds AGENTS.md → register 'agents-md' directive
      │  └─ registerAdapters() → adapter.directives[] → register 'adapter.fs', 'adapter.web', ...
      │
      ├─ blueprintRegistry.resolve('my-agent')
      │  └─ Returns: YAML wrapper factory
      │     └─ factory({ cwd, model, subagentFactory, domainAdapters: [fs, web, orch], writableRoots })
      │        └─ Returns: { adapters: [fs, web, orch], pipeline }
      │
      ├─ buildLlmAdapter({ model, cfg, args, systemPrompt: directives.build(20000) })
      │  └─ createAgentLoop({ model, systemPrompt, ... })
      │
      ├─ buildAgent({ llm, session: store, modelId, agentIdentity, onLoop, summaryWriter })
      │  ├─ new Agent()
      │  ├─ agent.load(llm)
      │  ├─ agent.load(loopGuard)
      │  └─ agent.load(sessionLog)
      │
      ├─ agent.load(fsAdapter)
      ├─ agent.load(webAdapter)
      ├─ agent.load(orchestrationAdapter)
      ├─ agent.load(toolShellAdapter)  // Unified tool interface
      ├─ agent.load(pipeline)
      ├─ agent.validate()  // Port cardinality check
      └─ agent.ready()     // Call ready() on all adapters
         └─ Returns: SessionHandle({ state, model, controller, agent, directives, ... })

3. ViewMode.run(session)
   └─ TuiViewMode → render interactive terminal
      └─ User types: "analyze the codebase"
         └─ session.send("analyze the codebase")
            └─ controller.send("analyze the codebase", "human")
               └─ agent.bus.publish("event", { type: "llm.input", payload: { text, role: "human" } })
                  └─ Pipeline stages run
                     ├─ memory stage → inject 10 recent turns
                     └─ compactor stage → check token budget (OK, no summarization needed)
                        └─ LLM adapter receives prepared messages
                           └─ Streaming response → llm.chunk signals → TUI updates
                              └─ Tool calls → fs.grep, fs.read, agent.run(explore)
                                 └─ Subagent spawns → returns findings
                                    └─ LLM synthesizes final reply → llm.response
                                       └─ SessionLog writes turn to store
                                          └─ TUI displays complete response
```

---

## 10. Summary

### Key Takeaways

1. **Agents are assembled, not instantiated**: No `new Agent(config)` — instead, adapters are loaded onto a kernel.

2. **Blueprints control the stack**: YAML or TypeScript factories define which adapters/tools are available.

3. **Profiles manage models**: Separate model selection from agent capabilities for flexible switching.

4. **Directives build prompts**: Priority-ordered blocks with workspace integration (AGENTS.md, custom .alef/*.md).

5. **Subagents are first-class**: Delegation via lightweight inner agents with restricted tools and budgets.

6. **Lifecycle is supervisor-managed**: Services (storage, session, agent, TUI) boot in dependency order.

7. **Event bus is the spine**: All communication flows through command/event/notification channels.

8. **Validation is multi-layered**: Port cardinality, payload schemas, turn limits, loop detection.

### Architecture Strengths

- **Composability**: Mix-and-match adapters without code changes
- **Testability**: Swap LLM for scripted responses, session for in-memory
- **Extensibility**: New blueprints/adapters drop in via registry
- **Observability**: Event bus + OTel tracing for debugging
- **Safety**: Capability-based (writable_roots, allowed_tools, token budgets)

### Design Philosophy

> "The agent is not a class with methods — it's a composition of adapters wired by a blueprint, directed by a system prompt, and executed by a controller."

The architecture favors **late binding** (runtime assembly), **separation of concerns** (blueprints vs. profiles vs. directives), and **explicit contracts** (adapter ports, event schemas). This makes the system both flexible (easy to reconfigure) and rigorous (validated at multiple layers).
