# Agent Lifecycle & Delegation Architecture

## Overview

The Alef agent system implements a sophisticated multi-level delegation and process isolation architecture. This document explores how `agent.run` works, the difference between in-process and spawned execution strategies, and how session management and process isolation are handled.

---

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Agent Lifecycle Flow](#agent-lifecycle-flow)
3. [The `agent.run` Command](#the-agentrun-command)
4. [Execution Strategies](#execution-strategies)
5. [Process Isolation](#process-isolation)
6. [Session Management](#session-management)
7. [Supervision & Blue-Green Deployment](#supervision--blue-green-deployment)
8. [Event Flow & Communication](#event-flow--communication)

---

## Core Concepts

### Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│  User/CLI                                                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  runAgent() - Entry Point                                    │
│  - ViewMode selection (TUI, Print, JSON)                     │
│  - Signal handling (SIGINT, SIGTERM)                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  AgentRuntime                                                │
│  - Session lifecycle management                              │
│  - Multi-session registry                                    │
│  - Storage factory integration                               │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  SessionHandle                                               │
│  - Agent wrapper (state, model, thinking)                    │
│  - Turn count & max-turns enforcement                        │
│  - Observer fan-out                                          │
│  - Adapter reload/unload                                     │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  Agent + AgentController                                     │
│  - Adapter orchestration (kernel-level)                      │
│  - Event bus (command/event/notification)                    │
│  - Tool catalog & dispatch                                   │
└──────────────────────┬──────────────────────────────────────┘
                       │
      ┌────────────────┴────────────────┐
      │                                  │
┌─────▼─────┐                 ┌─────────▼──────────┐
│  LLM      │                 │  AgentAdapter      │
│  Adapter  │                 │  (delegation)      │
└───────────┘                 └─────────┬──────────┘
                                        │
                        ┌───────────────┴───────────────┐
                        │                               │
                 ┌──────▼──────┐              ┌─────────▼─────────┐
                 │ InProcess   │              │ RemoteStrategy    │
                 │ Strategy    │              │ (spawned child)   │
                 └─────────────┘              └───────────────────┘
```

---

## Agent Lifecycle Flow

### 1. Startup Phase

**Entry: `packages/agent/src/run-agent.ts:runAgent()`**

```typescript
export async function runAgent(opts: RunAgentOptions): Promise<void> {
  // 1. Signal handlers
  process.once("SIGINT", () => process.exit(0));
  process.once("SIGTERM", async () => {
    opts.session.dispose();
    await shutdownOTel();
    process.exit(0);
  });

  // 2. View mode selection (print/JSON/TUI)
  const viewer = selectViewMode(args, interactiveOpts, opts.store);

  // 3. Run the session
  await viewer.run(opts.session);

  // 4. Cleanup
  await shutdownOTel();
}
```

### 2. Session Creation

**Path: `packages/agent/src/cli/local-session.ts`**

The session creation pipeline:

```typescript
1. Load/resume session store (JSONL file)
2. Build model adapter
3. Load domain adapters (fs, web, git, etc.)
4. Build delegation stack → creates AgentAdapter with strategies
5. Assemble agent server (LLM + adapters + pipeline)
6. Create SessionHandle wrapper
7. Return to viewer.run()
```

### 3. The SessionHandle Wrapper

**File: `packages/agent/src/session-lifecycle/handle.ts`**

The `SessionHandle` is a lightweight state wrapper that:

- **Owns runtime state**: model, thinking level, turn count, abort controller
- **Enforces constraints**: max-turns, model switching validation
- **Delegates to AgentController**: `send()`, `receive()`, `dispose()`
- **Fan-out to observers**: broadcasts all events to registered listeners
- **Adapter hot-reload**: `loadAdapter()`, `unloadAdapter()`, `reloadAdapter()`

Key methods:

```typescript
class SessionHandle {
  send(text: string, timeoutMs?: number): Promise<string> {
    if (this._turnCount >= this._args.maxTurns) {
      throw new Error("Max turns reached");
    }
    this._turnCount++;
    return this._controller.send(text, "human", timeoutMs);
  }

  setModel(id: string): void {
    this._currentModel = this._modelFactory(id);
    // Update thinking level based on model capabilities
    const supportsThinking = this._currentModel.reasoning && !this._currentModel.id.includes("haiku");
    if (!supportsThinking) this._thinkingState.level = undefined;
    this._notifyStateChanged();
  }

  dispose(): void {
    this._agent.dispose(); // Tears down all adapters
  }
}
```

### 4. Agent Assembly

**File: `packages/agent/src/assemble.ts`**

```typescript
function assembleAgentServer(opts: AgentServerOptions): AgentServer {
  const agent = new Agent({ bus: opts.bus });

  // Load LLM adapter
  agent.load(opts.llm);

  // Create tool shell (tool catalog + directives)
  const toolShell = createToolShellAdapter({
    tools: allAdapters.flatMap((o) => o.tools),
    getTools: () => agent.tools,
    adapterDirectives: buildAdapterDirectives(allAdapters),
  });
  agent.load(toolShell);

  // Load pipeline (context assembly, compaction)
  if (opts.pipeline) agent.load(opts.pipeline);

  // Load domain adapters (fs, web, git, etc.)
  for (const adapter of allAdapters) agent.load(adapter);

  // Create controller
  const controller = new AgentController(agent, {
    onReply: opts.onReply,
    transcript: opts.transcript,
  });

  return { agent, controller, observers };
}
```

---

## The `agent.run` Command

**File: `packages/tools/agent/src/adapter.ts`**

The `agent.run` tool is the **unified delegation facade** that supports:

1. **In-process delegation** (fast, default)
2. **Process-isolated ephemeral children** (`isolate: true`)
3. **Async fire-and-forget execution** (`async: true`)
4. **Routing to spawned persistent children** (by name)

### Tool Schema

```typescript
{
  text: string;                    // Task or question
  profile?: string;                // 'explore', 'general', or child name
  model?: string;                  // Override LLM model
  instructions?: string;           // Additional system prompt
  inheritDirectives?: boolean;     // Forward parent directives (default: true)
  adapters?: string[];             // Override adapter set
  isolate?: boolean;               // Spawn ephemeral child process
  stallMs?: number;                // Idle timeout (default: 2 min)
  maxMs?: number;                  // Hard wall-clock cap
  tokenBudget?: number;            // Soft token limit
  async?: boolean;                 // Fire-and-forget background execution
}
```

### Execution Flow

```typescript
// 1. Async mode - fire and forget
if (payload.async === true) {
  const taskId = `task-${++taskSeq}`;
  asyncTasks.set(taskId, { id: taskId, status: "running", ... });
  
  strategy.send({ text, timeoutMs, onChunk: ... })
    .then(reply => {
      task.status = "completed";
      task.reply = reply;
      // Emit task.completed notification
    })
    .catch(err => {
      task.status = "failed";
      task.error = err.message;
      // Emit task.failed notification
    });
  
  return { taskId, profile, async: true };
}

// 2. Isolated mode - ephemeral child process
if (isolate) {
  const childName = await handleSpawn(...);
  try {
    const reply = await handleAsk(childName, text, timeoutMs);
    return { reply, profile: `isolated:${childName}` };
  } finally {
    await handleKill(childName);
  }
}

// 3. Ad-hoc session with custom adapters/prompt
if (instructions || inheritDirectives || adapters) {
  const session = factory({
    adapters: resolvedAdapters,
    onChunk: (c) => queue.push(c),
    systemPrompt: [...parentDirectives, instructions].join("\n\n"),
    modelOverride: payload.model,
  });
  
  const replyPromise = session.send(text, timeoutMs);
  for await (const chunk of queue.iter()) yield { text: chunk };
  const reply = await replyPromise;
  session.dispose();
  return { reply, profile, elapsedMs, relevance };
}

// 4. Standard in-process delegation
const strategy = strategies.get(profile) ?? strategyRegistry.resolve(profile);
const reply = await strategy.send({
  text,
  timeoutMs,
  onChunk: (chunk) => queue.push(chunk),
  onInnerEvent: (callId, type, payload) => { ... },
});
return { reply, profile, elapsedMs, relevance };
```

### Profile Selection

```typescript
const explicitProfile = payload.profile;
const profile = explicitProfile ?? (needsWriteAccess(text) ? "general" : "explore");
```

- **`explore`**: Read-only strategy (fs.read, grep, find, web). Safe to parallelize.
- **`general`**: Full tool access (fs.edit, shell, git). Used when write access needed.
- **Custom profile**: Route to a spawned persistent child by name.

---

## Execution Strategies

### InProcessStrategy

**File: `packages/core/runtime/src/in-process.ts`**

Fast, lightweight delegation without process boundaries.

```typescript
class InProcessStrategy implements ExecutionStrategy {
  constructor(
    private readonly adapters: Adapter[],
    private readonly createSession: SubagentFactory,
    private readonly baseSystemPrompt?: string,
    private readonly onChunk?: (chunk: string) => void,
  ) {}

  async send({ text, timeoutMs, stallMs, signal, onChunk, onInnerEvent }: SendRequest): Promise<string> {
    // 1. Create watchdog for stall detection
    const watchdog = new Watchdog(stallMs, () => {
      session.dispose(); // Kill stalled session
    });

    // 2. Create ad-hoc session with adapters
    const session = this.createSession({
      adapters: this.adapters,
      onChunk: (chunk) => {
        watchdog.reset(); // Activity detected
        onChunk?.(chunk);
      },
      onInnerEvent: (callId, type, payload) => {
        watchdog.reset(); // Activity detected
        onInnerEvent?.(callId, type, payload);
      },
      systemPrompt: this.baseSystemPrompt,
    });

    // 3. Send prompt, wait for reply
    watchdog.start();
    const reply = await session.send(text, timeoutMs);
    watchdog.stop();

    // 4. Cleanup
    session.dispose();
    return reply;
  }
}
```

**Key features:**

- **Stall detection**: Watchdog kills session if no activity (chunks, tool calls, events) for `stallMs`.
- **No process boundary**: Runs in the same Node.js process.
- **Ephemeral**: Each `send()` creates a new session, then disposes it.
- **Fast startup**: No process spawn overhead (~0-10ms vs 15-30s for child process).

### RemoteStrategy

**File: `packages/core/runtime/src/remote-strategy.ts`**

Delegates to a spawned child process via HTTP/SSE.

```typescript
class RemoteStrategy implements ExecutionStrategy {
  async send({ text, timeoutMs, signal, onChunk, onInnerEvent }: SendRequest): Promise<string> {
    // 1. Start SSE connection to child's /events endpoint
    const replyPromise = collectReply(
      this.endpoint,
      timeoutMs,
      this.replyEvent,
      (ev) => {
        watchdog?.reset(); // Activity detected

        if (ev.type === "llm.chunk") onChunk?.(ev.payload.text);
        if (ev.type === "llm.tool-chunk") onChunk?.(ev.payload.text);
        // Forward all events to parent
        onInnerEvent?.("remote", ev.type, ev.payload);
      }
    );

    // 2. POST message to child's /message endpoint
    await postMessage(this.endpoint, text, timeoutMs);

    // 3. Wait for llm.response event (or timeout)
    const reply = await replyPromise;
    return reply ?? "";
  }
}
```

**Key features:**

- **Process isolation**: Child runs in a separate Node.js process.
- **HTTP/SSE communication**: Parent posts messages, child streams events.
- **Stall detection**: Watchdog kills child if no SSE events for `stallMs`.
- **Persistent**: Child can handle multiple prompts (via `agent.ask` tool).

---

## Process Isolation

### Child Process Lifecycle

**File: `packages/tools/agent/src/child-process.ts`**

#### 1. Spawning a Child

```typescript
export async function spawnChild(opts: SpawnChildOptions): Promise<{
  child: ChildProcess;
  endpoint: string;
  sessionId: string | undefined;
  tmpDir?: string;
}> {
  // 1. Create temporary blueprint if adapters specified
  let tmpDir: string | undefined;
  if (adapters.length > 0 && !blueprintPath) {
    tmpDir = mkdtempSync(join(tmpdir(), "alef-sup-"));
    blueprintPath = join(tmpDir, "agent.yaml");
    writeFileSync(blueprintPath, stringifyYaml({
      apiVersion: "alef.dpopsuev.io/v1alpha1",
      kind: "AgentRuntime",
      spec: { adapters: adapters.map(p => ({ path: resolvePath(p, childCwd) })) }
    }));
  }

  // 2. Build command: tsx + runner main + args
  const args = [TSX_BIN, RUNNER_MAIN, "--serve", "0", "--no-tui"];
  if (blueprintPath) args.push("--blueprint", blueprintPath);
  if (sessionId) args.push("--resume", sessionId);

  // 3. Set environment
  const env = {
    ...process.env,
    ALEF_SUPERVISOR: "1",
    ALEF_AGENT_DEPTH: String(opts.childDepth),
    ALEF_WRITABLE_ROOTS: JSON.stringify(opts.writableRoots),
  };

  // 4. Spawn (with optional sandbox via bwrap)
  const [spawnCmd, spawnArgs] = opts.sandbox 
    ? wrapWithBwrap([process.execPath, ...args])
    : [process.execPath, args];
  
  const child = spawn(spawnCmd, spawnArgs, { cwd: childCwd, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });

  // 5. Wait for readiness signal
  const { endpoint, sessionId } = await waitForReady(child, opts.readinessTimeoutMs);

  return { child, endpoint, sessionId, tmpDir };
}
```

**Readiness detection:**

```typescript
function waitForReady(child: ChildProcess, timeoutMs: number): Promise<{
  endpoint: string;
  sessionId: string | undefined;
}> {
  return new Promise((resolve, reject) => {
    const scan = (chunk: Buffer) => {
      const text = chunk.toString();
      
      // Parse session ID: "[session] <id>"
      const sessionMatch = text.match(/\[session\]\s+(\S+)/);
      if (sessionMatch) sessionId = sessionMatch[1];
      
      // Parse endpoint: "[alef] router listening on http://127.0.0.1:12345"
      const routerMatch = text.match(/router listening on (http:\/\/[\d.]+:\d+)/);
      if (routerMatch) {
        endpoint = routerMatch[1];
        resolve({ endpoint, sessionId });
      }
    };

    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    
    child.once("exit", (code) => {
      reject(new Error(`Child exited (${code}) before ready`));
    });

    setTimeout(() => reject(new Error("Child readiness timeout")), timeoutMs);
  });
}
```

#### 2. Sandbox Support (bwrap)

```typescript
function wrapWithBwrap(cmd: string[]): [string, string[]] {
  return [BWRAP_PATH, [
    "--ro-bind", "/", "/",       // Read-only root
    "--dev", "/dev",             // Device access
    "--proc", "/proc",           // Process info
    "--tmpfs", "/tmp",           // Ephemeral /tmp
    "--unshare-net",             // Network isolation
    "--die-with-parent",         // Auto-kill on parent exit
    "--", ...cmd
  ]];
}
```

#### 3. Child Registry

**File: `packages/tools/agent/src/child-registry.ts`**

Manages lifecycle of persistent children:

```typescript
interface ChildEntry {
  name: string;            // "child-1", "child-2", etc.
  endpoint: string;        // "http://127.0.0.1:12345"
  sessionId?: string;      // For continuity
  pid: number;
  process: ChildProcess;
  startedAt: number;
  tmpDir?: string;         // Cleanup on exit
}

class ChildRegistry {
  private entries = new Map<string, ChildEntry>();
  private seq = 0;

  nextName(): string {
    return `child-${++this.seq}`;
  }

  register(entry: ChildEntry): void {
    this.entries.set(entry.name, entry);
    
    // Auto-reap on exit
    entry.process.once("exit", (code, signal) => {
      this.remove(entry.name);
      this.opts.onReaped?.(entry.name, `exit ${code}/${signal}`, code ?? -1);
      if (entry.tmpDir) rmSync(entry.tmpDir, { recursive: true });
    });
  }
}
```

### Agent Tools for Child Management

**File: `packages/tools/agent/src/child-lifecycle.ts`**

#### `agent.spawn` - Start Persistent Child

```typescript
async function handleSpawn(deps, ctx): Promise<{ name: string; endpoint: string }> {
  // 1. Depth check (prevent infinite recursion)
  if (deps.currentDepth >= deps.maxDepth) {
    throw new Error(`Depth limit reached (max: ${deps.maxDepth})`);
  }

  // 2. Spawn child process
  const result = await spawnChild({
    cwd: deps.cwd,
    blueprintPath: ctx.payload.blueprintPath,
    adapters: ctx.payload.adapters,
    childDepth: deps.currentDepth + 1,
  });

  // 3. Register in registry
  const name = deps.registry.nextName();
  deps.registry.register({
    name,
    endpoint: result.endpoint,
    sessionId: result.sessionId,
    pid: result.child.pid,
    process: result.child,
    startedAt: Date.now(),
    tmpDir: result.tmpDir,
  });

  // 4. Create RemoteStrategy for this child
  const strategy = new RemoteStrategy({
    endpoint: result.endpoint,
    replyEvent: deps.replyEvent,
  });
  deps.strategies.set(name, strategy);

  return { name, endpoint: result.endpoint, sessionId: result.sessionId };
}
```

#### `agent.ask` - Send Prompt to Child

```typescript
async function handleAsk(deps, ctx): Promise<{ reply: string }> {
  const { name, prompt, stallMs, maxMs } = ctx.payload;
  const entry = deps.registry.get(name);
  if (!entry) throw new Error(`No child named '${name}'`);

  const strategy = new RemoteStrategy({
    endpoint: entry.endpoint,
    replyEvent: deps.replyEvent,
    stallMs,
    onStall: () => {
      entry.process.kill("SIGTERM");
      deps.registry.remove(name);
    },
  });

  const reply = await strategy.send({
    text: prompt,
    timeoutMs: maxMs,
    onInnerEvent: (callId, type, payload) => {
      // Forward inner events to parent
      deps.publishInnerSignal?.(type, { ...payload, callId }, ctx.correlationId);
    },
  });

  return { reply };
}
```

#### `agent.race` - Parallel Prompts

```typescript
async function handleRace(deps, ctx): Promise<{
  results: Array<{ name: string; reply: string | null; error: string | null }>;
}> {
  const { tasks, stallMs, maxMs } = ctx.payload;

  const results = await Promise.allSettled(
    tasks.map(async ({ name, prompt }) => {
      const entry = deps.registry.get(name);
      if (!entry) return { name, reply: null, error: "not found" };

      const strategy = new RemoteStrategy({
        endpoint: entry.endpoint,
        replyEvent: deps.replyEvent,
        stallMs,
      });

      const reply = await strategy.send({ text: prompt, timeoutMs: maxMs });
      return { name, reply, error: null };
    })
  );

  return { results: results.map(r => r.status === "fulfilled" ? r.value : { ...r.reason }) };
}
```

#### `agent.converse` - Multi-turn Conversation

```typescript
async function handleConverse(deps, ctx): Promise<{
  transcript: Array<{ role: "parent" | "child"; text: string }>;
}> {
  const { name, prompts, stallMs, maxMs } = ctx.payload;
  const entry = deps.registry.get(name);
  
  const transcript: Array<{ role: "parent" | "child"; text: string }> = [];
  const conversationStart = Date.now();

  for (const prompt of prompts) {
    if (Date.now() - conversationStart > maxMs) {
      transcript.push({ role: "parent", text: "[conversation timed out]" });
      break;
    }

    transcript.push({ role: "parent", text: prompt });

    const remainingMs = Math.max(MIN_REMAINING_MS, maxMs - (Date.now() - conversationStart));
    const strategy = new RemoteStrategy({ endpoint: entry.endpoint, replyEvent: deps.replyEvent, stallMs });

    try {
      const reply = await strategy.send({ text: prompt, timeoutMs: remainingMs });
      transcript.push({ role: "child", text: reply || "(no reply)" });
    } catch (err) {
      transcript.push({ role: "child", text: `[error: ${err.message}]` });
      break;
    }
  }

  return { transcript };
}
```

#### `agent.kill` - Stop Child

```typescript
async function handleKill(deps, ctx): Promise<void> {
  const { name } = ctx.payload;
  const entry = deps.registry.get(name);
  if (!entry) return;

  entry.process.kill("SIGTERM");
  
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      entry.process.kill("SIGKILL"); // Escalate if SIGTERM ignored
      resolve();
    }, SIGKILL_GRACE_MS);
    
    entry.process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  deps.registry.remove(name);
  deps.strategies.delete(name);
}
```

---

## Session Management

### Session Store (JSONL)

**File: `packages/core/session/src/jsonl-store.ts`** (inferred)

Each session is a JSONL file in `~/.local/share/alef/sessions/<cwd-hash>/<session-id>.jsonl`:

```jsonl
{"role":"human","content":"read the README"}
{"role":"assistant","content":"The README describes..."}
{"role":"human","content":"what's in src/?"}
{"role":"assistant","content":"The src/ directory contains..."}
```

### Session Lifecycle

```typescript
// 1. Create or resume
const store = args.resume 
  ? await sessions.resume(args.cwd, args.resume)
  : await sessions.create(args.cwd);

// 2. Load turns into context
const turns = await store.turns();
const messages = turns.map(t => ({ role: t.role, content: t.content }));

// 3. Append new turns
store.appendTurn({ role: "human", content: text });
store.appendTurn({ role: "assistant", content: reply });

// 4. Auto-summarization (when context full)
pipeline.addStage("compactor", createCompactionStage({
  contextWindow,
  summarize: async (messages) => {
    // LLM summarizes old turns
    const summary = await llm.summarize(messages);
    return summary;
  },
}));
```

### Multi-Session Support

**File: `packages/agent/src/agent-runtime.ts`**

```typescript
class AgentRuntime {
  private sessions = new Map<string, SessionHandle>();

  async startSession(args, cfg, log, store, loaded, model, storage, identity): Promise<StartedSession> {
    const { session, resolvedModelDisplay, humanAddress, agentAddress } = 
      await createLocalSession(args, cfg, log, store, loaded, model, storage, identity);
    
    await setupSurface(); // HTTP router if --serve
    this.sessions.set(session.state.id, session);
    
    return { session, resolvedModelDisplay, humanAddress, agentAddress, identity };
  }

  get(id: string): SessionHandle | undefined {
    return this.sessions.get(id);
  }

  stopSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.dispose();
      this.sessions.delete(id);
    }
  }
}
```

---

## Supervision & Blue-Green Deployment

**File: `packages/agent/src/supervisor.ts`**

The supervisor enables **zero-downtime adapter promotion** via blue-green deployment.

### Architecture

```
┌─────────────────────────────────────────────────┐
│  Supervisor Process                              │
│  - Manages "current" green slot                  │
│  - Listens for IPC { type: "rebuild" }           │
└─────────────────┬───────────────────────────────┘
                  │
                  │ IPC
                  │
┌─────────────────▼───────────────────────────────┐
│  Green Runner Process                            │
│  - Serves HTTP/SSE on dynamic port               │
│  - Emits "[session] <id>" on start               │
│  - Emits "router listening on http://..."        │
└──────────────────────────────────────────────────┘
```

### Rebuild Flow

```typescript
async function doRebuild(): Promise<void> {
  // 1. Run build command
  if (BUILD_COMMAND) {
    await exec(BUILD_COMMAND);
  }

  // 2. Eval gate (test hook)
  if (TEST_EVAL_RESULT === "fail") {
    console.error("[supervisor] eval gate: FAIL — aborting");
    return;
  }

  // 3. Spawn new green with session continuity
  const newGreen = spawnGreen(currentSessionId);

  // 4. Wait for new green readiness
  await readyPromise; // Resolves when "router listening on" detected

  // 5. Graceful handoff
  if (oldGreen && !oldGreen.killed) {
    const updateId = randomUUID();
    oldGreen.send({ type: "handoff_prepare", envelope: { updateId, sessionFile: currentSessionId } });
    
    // Wait for ack (with 5s timeout)
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5_000);
      oldGreen.on("message", (msg) => {
        if (msg.type === "handoff_ack" && msg.updateId === updateId) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    oldGreen.kill("SIGTERM");
  }

  current = newGreen;
  console.error("[supervisor] Promoted staging slot.");
}
```

### Session Continuity

The supervisor captures the session ID from the old green's stderr and passes it to the new green:

```typescript
function spawnGreen(sessionId?: string): ChildProcess {
  const env = { ...process.env };
  if (sessionId) env.ALEF_CURRENT_SESSION = sessionId;

  const child = spawn(process.execPath, [TSX_BIN, RUNNER_MAIN, ...args], { env, stdio: ["inherit", "pipe", "pipe", "ipc"] });

  child.stderr.on("data", (chunk) => {
    const sessionMatch = chunk.toString().match(/\[session\]\s+(\S+)/);
    if (sessionMatch) currentSessionId = sessionMatch[1];
  });

  return child;
}
```

Then the runner resumes the session:

```typescript
const sessionId = process.env.ALEF_CURRENT_SESSION;
const store = sessionId 
  ? await sessions.resume(args.cwd, sessionId)
  : await sessions.create(args.cwd);
```

---

## Event Flow & Communication

### In-Process Delegation

```
Parent Agent
  │
  ├─ LLM calls agent.run("explore packages")
  │    │
  │    └─ AgentAdapter dispatches to InProcessStrategy
  │         │
  │         ├─ SubagentFactory creates ephemeral session
  │         │    │
  │         │    ├─ New Agent instance
  │         │    ├─ LLM adapter (inherited model)
  │         │    └─ Filtered adapters (explore: fs.read, grep, find, web)
  │         │
  │         ├─ session.send("explore packages", 300_000ms)
  │         │    │
  │         │    └─ Inner LLM responds "spine, corpus, runner"
  │         │
  │         ├─ session.dispose()
  │         │
  │         └─ Returns reply to parent
  │
  └─ LLM receives toolResult { reply: "spine, corpus, runner" }
```

### Remote Delegation (Spawned Child)

```
Parent Agent
  │
  ├─ LLM calls agent.spawn({ blueprintPath: "research.yaml" })
  │    │
  │    └─ AgentAdapter → handleSpawn()
  │         │
  │         ├─ spawnChild() forks new Node.js process
  │         │    │
  │         │    ├─ Child runs alef-runner main with --serve 0
  │         │    ├─ Child emits "[session] abc-123"
  │         │    └─ Child emits "router listening on http://127.0.0.1:45678"
  │         │
  │         ├─ waitForReady() parses endpoint from child stderr
  │         ├─ ChildRegistry.register({ name: "child-1", endpoint, pid })
  │         └─ Creates RemoteStrategy(endpoint)
  │
  └─ LLM calls agent.ask({ name: "child-1", prompt: "scan the codebase" })
       │
       └─ AgentAdapter → handleAsk()
            │
            ├─ RemoteStrategy.send({ text: "scan the codebase" })
            │    │
            │    ├─ POST http://127.0.0.1:45678/message { text }
            │    ├─ SSE http://127.0.0.1:45678/events
            │    │    │
            │    │    ├─ data: {"type":"llm.chunk","payload":{"text":"Scanning..."}}
            │    │    ├─ data: {"type":"llm.tool-start","payload":{"name":"fs.read",...}}
            │    │    └─ data: {"type":"llm.response","payload":{"text":"Found 23 files"}}
            │    │
            │    └─ Returns "Found 23 files"
            │
            └─ Returns toolResult { reply: "Found 23 files" }
```

### Event Types

**Notification Bus Events:**

- `llm.chunk` - Streaming text
- `llm.thinking` - Extended thinking text (Claude)
- `llm.tool-start` - Tool call initiated
- `llm.tool-end` - Tool call completed
- `llm.tool-chunk` - Streaming tool output
- `llm.tool-stall` - Tool idle too long
- `llm.token-usage` - Token consumption
- `agent.run.inner` - Nested delegation events (callId routing)
- `task.progress` - Async task chunks
- `task.completed` - Async task success
- `task.failed` - Async task error

**Command Bus Events:**

- `llm.input` - User/system sends message
- `llm.response` - LLM replies
- `budget.cancel` - Abort current turn

---

## Key Design Decisions

### 1. Why Both InProcessStrategy and RemoteStrategy?

- **InProcessStrategy**: Fast, lightweight, ephemeral. Ideal for quick reads, searches, parallel exploration.
- **RemoteStrategy**: Process-isolated, persistent. Required for:
  - Long-running agents (e.g., code review daemon)
  - Sandbox/security isolation
  - Resource quotas (kill child on timeout)
  - Adapter hot-reload without restarting parent

### 2. Why SessionHandle Wrapper?

Separates **stable state** (model, thinking, turn count) from **agent plumbing** (adapters, bus, tools). Benefits:

- Hot-reload adapters without breaking TUI state
- Enforce max-turns at session level, not LLM level
- Observer fan-out without polluting Agent core
- Clean disposal (one `session.dispose()` tears down everything)

### 3. Why Blue-Green Supervisor?

Enables **zero-downtime adapter promotion**:

1. Dev writes new adapter
2. Agent calls `agent.promote({ adapterPath: "./my-adapter.ts" })`
3. Supervisor rebuilds, spawns new green, waits for readiness
4. Old green hands off session state, shuts down
5. New green resumes session with promoted adapter

This allows agents to **upgrade themselves** without human intervention.

### 4. Why Depth Limits?

Prevents infinite recursion:

```typescript
if (deps.currentDepth >= deps.maxDepth) {
  throw new Error("Depth limit reached (max: 3)");
}
```

Each child increments `ALEF_AGENT_DEPTH`:

```
Parent (depth=0)
  └─ Child-1 (depth=1)
      └─ Child-2 (depth=2)
          └─ Child-3 (depth=3) ✗ BLOCKED
```

### 5. Why Async Tasks?

**Fire-and-forget delegation** for long-running background tasks:

```typescript
agent.run({ text: "analyze 1000 files", async: true })
// Returns immediately: { taskId: "task-1", async: true }

// Later:
agent.tasks({ taskId: "task-1" })
// Returns: { status: "completed", reply: "Analysis complete: 1000 files, 23 issues" }
```

Emits:
- `task.progress` (chunks)
- `task.completed` (success)
- `task.failed` (error)

---

## Performance Characteristics

| Strategy | Startup | Memory | Isolation | Parallelism | Use Case |
|----------|---------|--------|-----------|-------------|----------|
| InProcessStrategy | ~0-10ms | Shared | None | Safe (per-turn) | Quick reads, searches |
| RemoteStrategy | ~15-30s | Isolated | Full | Safe (per-child) | Long-running, sandbox |

**Watchdog Timings:**

- `stallMs` (default: 2 min) - Idle timeout (no chunks, tool calls, events)
- `maxMs` (optional) - Hard wall-clock cap
- `conversationTimeoutMs` (default: 5 min) - Per-turn budget

---

## Conclusion

The Alef agent lifecycle and delegation architecture is built around:

1. **Layered abstraction**: ViewMode → SessionHandle → Agent → Adapters
2. **Dual execution modes**: In-process (fast) vs. spawned (isolated)
3. **Unified delegation API**: `agent.run` covers all scenarios
4. **Session continuity**: JSONL stores + supervisor handoff
5. **Zero-downtime promotion**: Blue-green deployment for adapter upgrades
6. **Event-driven coordination**: Notification bus for tool lifecycle, chunks, inner events

This design enables:
- **Rapid prototyping** (in-process delegation)
- **Production isolation** (spawned children)
- **Self-upgrading agents** (supervisor + promote)
- **Multi-agent orchestration** (parallel delegation, race, converse)

The key insight: **separate execution strategy from delegation API**. The caller doesn't care if the subagent runs in-process or in a container — it's all `agent.run({ text })`.
