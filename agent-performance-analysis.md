# Agent Package Performance Analysis

## Executive Summary

The `packages/agent` package implements a sophisticated agent runtime with multiple performance-oriented features including process lifecycle management, IPC-based session handoff, resource metering, loop detection, and concurrent execution support. The architecture emphasizes clean resource cleanup, bounded resource consumption, and graceful degradation under load.

---

## 1. Process Management

### 1.1 Process Lifecycle Architecture

The agent uses a **supervisor-based architecture** for managing long-running daemon processes:

**Key Components:**
- **Supervisor** (`@dpopsuev/alef-supervisor`): Orchestrates service lifecycle
- **Service Descriptors**: Define restart policies, dependencies, and health checks
- **Session Service**: Manages agent session state
- **Agent Service**: Thin wrapper coordinating session setup
- **TUI Service**: Terminal UI with completion signaling

**Service Restart Policies:**
```typescript
// From session-service.ts & agent-service.ts
{
  name: "session",
  restart: "permanent",  // Auto-restart on failure
  shareable: true,       // Can be accessed by multiple services
  dependsOn: ["storage"]
}

{
  name: "agent", 
  restart: "permanent",
  shareable: false,
  dependsOn: ["session"]
}
```

### 1.2 Process Spawning & Child Process Management

**npm-backed Package Management (alef-pm.ts):**
```typescript
// Uses promisified child_process.exec
const exec = promisify(execCb);

async function runNpm(...args: string[]): Promise<void> {
  if (process.env.ALEF_PM_SKIP_NPM === "1") return;
  const cmd = `npm ${args.join(" ")} --prefix ${PM_ROOT}`;
  const { stderr } = await exec(cmd);
  // No explicit child process tracking - relies on await
}
```

**External Tool Execution:**
- Uses `execSync` for one-shot commands (terminal background query, font detection)
- Timeouts enforced at call site (e.g., 200ms for terminal queries, 2000ms for font commands)
- No persistent worker pools - tools spawn on-demand

**Subprocess Lifecycle:**
- **No explicit process pool** - each tool spawns fresh
- **Timeout enforcement** via command-line tools (grep timeout flag, execSync timeout option)
- **No zombie cleanup code** - relies on Node.js child_process auto-reaping

### 1.3 Daemon Registry & Session Discovery

**Storage Layer (daemon registry):**
```typescript
// From agent-service.ts
const daemonRegistry = opts.storage.daemonRegistry();
await daemonRegistry.register({
  port: listenPort,
  pid: process.pid,
  sessionId: sessionSvc.session.state.id,
  cwd: opts.args.cwd,
  startedAt: Date.now(),
});
```

**Remote Session Reconnect:**
```typescript
// From strategies/remote-session.ts
private scheduleReconnect(): void {
  if (this.disposed) return;
  this.reconnectTimer = setTimeout(() => {
    this.reconnectTimer = null;
    this.connectSse();
  }, 1_000);
}
```

---

## 2. IPC Mechanisms

### 2.1 HTTP-Based Router (Primary IPC)

**RouterAdapter** (`build-delegation.ts`):
```typescript
const router = createRouterAdapter({
  port: servePort,
  allowedEvents,
  triggerEvent: "llm.input",
  onMessage: (text) => session.receive?.(text),
  onCancel: () => {
    agent.publishEvent({
      type: "budget.cancel",
      payload: { reason: "cancelled by attached client" },
      correlationId: "remote-cancel",
    });
  },
  getHistory: () => history,  // Last 500 events cached
});
```

**Performance Characteristics:**
- **Event History Buffer**: Fixed 500 event ring buffer
- **SSE Streaming**: Server-Sent Events for real-time updates
- **No Request Queuing**: Direct pass-through to session
- **No Rate Limiting**: Unbounded request acceptance

### 2.2 Server-Sent Events (SSE)

**Remote Session SSE Client:**
```typescript
// From strategies/remote-session.ts
private connectSse(): void {
  let buf = "";
  this.sseReq = http.get(`http://127.0.0.1:${port}/events`, (res) => {
    res.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";  // Efficient frame splitting
      for (const frame of frames) {
        // Parse and notify observers
      }
    });
  });
}
```

**Connection Management:**
- **Auto-Reconnect**: 1s delay on disconnection
- **Graceful Shutdown**: Cleanup via `dispose()` 
- **No Backpressure**: Observers receive all events immediately

### 2.3 Supervisor IPC (Blue-Green Handoff)

**Handoff Protocol** (from test files):
```typescript
// Parent → Green: handoff_prepare message
process.send({
  type: "handoff_prepare",
  envelope: {
    updateId: "...",
    sessionFile: join(cwd, "session.jsonl"),
    phase: "prepared",
  }
});

// Green → Parent: handoff_ack response
process.send({
  type: "handoff_ack",
  updateId: "...",
});
```

**Timeout Handling:**
- **5-second handoff timeout**: Supervisor promotes new green even without ACK
- **Graceful fallback**: Old green keeps serving if new green crashes

---

## 3. Concurrency Model

### 3.1 Single-Threaded Event Loop

**No Worker Threads:**
- All adapter execution on main thread
- Async/await for I/O concurrency
- No CPU-bound parallelism

### 3.2 Message Queue & Turn Serialization

**AgentController Message Queue:**
```typescript
// From test/concurrent-prompts.test.ts
it("two rapid sends both eventually settle", async () => {
  const p1 = h.send({ text: "First prompt" });
  const p2 = h.send({ text: "Second prompt" });
  // Both settle - queued sequentially
});
```

**Queue Notifications:**
```typescript
// From assemble.ts
case "llm.message-queued":
  return { type: "message-queued", queueLength: Number(p.queueLength ?? 0) };
```

**Turn Execution:**
- **Sequential turns**: One LLM interaction at a time
- **Concurrent tool calls**: Multiple tools can run in parallel within a turn
- **No turn preemption**: Current turn must complete before next begins

### 3.3 Parallel Tool Execution

**Batch Timing Tracking:**
```typescript
// From cli/tui-state.ts
export interface TuiState {
  activeCalls: Map<string, ActiveCall>;
  batchStartedAt: number | null;  // Track parallel batch start
  // ...
}

// From cli/tui-dispatch.ts
const batchDone = activeCalls.size === 0 && state.batchStartedAt !== null;
if (batchDone) {
  writer.addBatchTiming(Date.now() - (state.batchStartedAt ?? 0));
}
```

**System Prompt Guidance:**
```typescript
// From prompt.ts
"Use parallel agent.run(explore) calls for multi-file codebase exploration. 
Batch independent tool calls in a single parallel invocation."
```

### 3.4 Subagent Concurrency

**In-Process Strategy:**
```typescript
// From subagent-factory.ts
const factory = buildSubagentFactory({
  model,
  trackConcurrentOps: true,      // Enable concurrency tracking
  forwardToolChunks: true,        // Stream chunks to parent
});
```

**Concurrent Operation Tracking:**
- Enabled only for HTTP-served sessions (`args.serve !== undefined`)
- Used for delegation stack in `build-delegation.ts`

---

## 4. Resource Limits & Budgets

### 4.1 Token Budget Enforcement

**Subagent Token Limiting:**
```typescript
// From subagent-factory.ts
observers.add((event) => {
  if (event.type === "token-usage") {
    totalInputTokens += usage.input;
    totalOutputTokens += usage.output;
    
    if (tokenBudget && !budgetExceeded && 
        totalInputTokens + totalOutputTokens >= tokenBudget) {
      budgetExceeded = true;
      controller.receive(
        "[system] Token budget reached. Wrap up now...",
        "system"
      );
    }
  }
});
```

**Token Tracking:**
```typescript
// From resource-meter.ts
const tokens = { input: 0, output: 0, cacheRead: 0 };
bus.notification.subscribe("*", (event) => {
  if (event.type === "llm.token-usage") {
    tokens.input += usage.input ?? 0;
    tokens.output += usage.output ?? 0;
    tokens.cacheRead += usage.cacheRead ?? 0;
  }
});
```

### 4.2 Timeout Hierarchies

**Timeout Layers:**
```typescript
// Per-request HTTP timeout (config.ts)
llm: {
  timeoutMs: 60_000,  // Default: 60s
}

// Tool execution timeout (from agent-run-timeout.test.ts)
DEFAULT_TOOL_TIMEOUT_MS = 300_000  // 5 minutes

// Session conversation timeout
DEFAULT_CONVERSATION_MS = 900_000  // 15 minutes

// Turn send timeout (multiple locations)
await controller.send(text, "human", timeoutMs);
// Default values:
// - HeadlessViewMode.send(): 30_000ms
// - meta-agent.ts: 60_000ms  
// - tui-submit.ts: 3_600_000ms (1 hour)
```

**Timeout Enforcement:**
```typescript
// From run-agent.ts - Graceful shutdown timeout
await Promise.race([
  shutdownOTel(), 
  new Promise<void>((resolve) => setTimeout(resolve, 2000).unref())
]);
```

### 4.3 Loop Detection & Circuit Breaking

**LoopGuard Adapter:**
```typescript
// From loop-detector.ts
export class LoopGuard {
  constructor(opts: {
    repeatedInteractionThreshold?: number;  // Default: 3
    totalCallThreshold?: number;            // Default: 40
    onLoop?: (eventType: string, reason: string) => void;
  })
}
```

**Detection Logic:**
```typescript
// Interaction hash: args + result
const interactionHash = `${argsHash}\x00${resultHash}`;

// Per-tool interaction counter
const prev = perType.get(interactionHash) ?? 0;
const next = prev + 1;
perType.set(interactionHash, next);

if (next > this.repeatedInteractionThreshold) {
  this.onLoop(type, 
    `Tool '${type}' produced identical output ${next} times...`);
}

// Total call safety net
if (nextTotal > this.totalCallThreshold) {
  this.onLoop(type,
    `Tool '${type}' called ${nextTotal} times in one turn...`);
}
```

**Integration:**
```typescript
// From agent-kernel.ts
agent.load(new LoopGuard({
  repeatedInteractionThreshold: opts.loopThreshold,
  onLoop: opts.onLoop,  // Typically aborts AbortController
}));
```

### 4.4 Turn Limits

**Max Turns Enforcement:**
```typescript
// From session-lifecycle/handle.ts
send = (text: string, timeoutMs?: number): Promise<string> => {
  if (this._args.maxTurns > 0 && this._turnCount >= this._args.maxTurns) {
    return Promise.reject(
      new Error(`Max turns reached (${this._args.maxTurns})...`)
    );
  }
  this._turnCount++;
  return this._controller.send(text, "human", timeoutMs);
};
```

**Configuration:**
- Set via `--max-turns` CLI argument (args.ts)
- Default: unlimited (0)

---

## 5. Cleanup Strategies

### 5.1 Dispose Pattern

**Session Disposal Chain:**
```typescript
// From session-lifecycle/handle.ts
dispose(): void {
  this._agent.dispose();  // Cascades to all adapters
}

// From agent-service.ts
stop() {
  stopped = true;
  handle.dispose();
  return Promise.resolve();
}
```

**Agent Cleanup:**
```typescript
// From subagent-factory.ts
dispose: () => {
  opts.actorRoutes?.unregister(subActor.color);  // Route cleanup
  agent.dispose();                               // Adapter unmount
},
```

### 5.2 Timer & Resource Cleanup

**Explicit Timer Management:**
```typescript
// From cli/prompt-console.ts
private thinkingTimer: ReturnType<typeof setTimeout> | undefined;

startThinking(): void {
  clearTimeout(this.thinkingTimer);  // Clean previous timer
  const tick = () => {
    // ... animation logic
    this.thinkingTimer = setTimeout(tick, pressureToInterval(level));
  };
  this.thinkingTimer = setTimeout(tick, pressureToInterval(0));
}

stopThinking(): void {
  clearTimeout(this.thinkingTimer);
  this.thinkingTimer = undefined;
}
```

**SSE Connection Cleanup:**
```typescript
// From strategies/remote-session.ts
dispose(): void {
  this.disposed = true;
  if (this.reconnectTimer !== null) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  this.sseReq?.destroy();  // HTTP request cleanup
  this.sseReq = null;
  this.observers.clear();   // Observer set cleanup
}
```

### 5.3 Signal Handlers

**Graceful Shutdown:**
```typescript
// From run-agent.ts
process.once("SIGINT", () => {
  process.exit(0);
});

process.once("SIGTERM", async () => {
  process.stderr.write("\n[signal] SIGTERM — shutting down cleanly\n");
  try {
    opts.session.dispose();
    await shutdownOTel();
  } finally {
    process.exit(0);
  }
});
```

**TUI Ctrl+C Handling:**
```typescript
// From cli/tui-commands.ts
if (ctx.tui.state.editor.outerMode === "insert") {
  ctx.tui.requestRender(true);  // Cancel input mode
} else {
  traceEvent("ctrl+c:idle:dispose");
  ctx.session.dispose();
  ctx.tui.stop();
}
```

### 5.4 Generation-Based Garbage Collection

**Package Manager GC:**
```typescript
// From alef-pm.ts
export function gc(keep = 10): { 
  removedGenerations: number; 
  removedStoreEntries: number 
} {
  const files = readdirSync(GEN_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => b.id - a.id);

  const toRemove = files.slice(keep);
  for (const { file } of toRemove) {
    rmSync(join(GEN_DIR, file));  // Remove old generations
  }

  // Collect referenced hashes from kept generations
  const referencedHashes = new Set<string>();
  // ... populate set ...

  // Remove unreferenced local-store entries
  if (existsSync(LOCAL_STORE)) {
    for (const entry of readdirSync(LOCAL_STORE)) {
      if (!referencedHashes.has(entry)) {
        rmSync(join(LOCAL_STORE, entry), { recursive: true, force: true });
        removedStoreEntries++;
      }
    }
  }
}
```

---

## 6. Performance Optimizations

### 6.1 Event Pressure Gauge

**Adaptive Spinner Speed:**
```typescript
// From event-pressure.ts
export class EventPressure {
  private value = 0;
  private lastDecayAt = Date.now();

  pulse(): void {
    this.applyDecay();
    this.value = Math.min(1, this.value + this.pulseStrength);  // 0.25
  }

  level(): number {
    this.applyDecay();
    return Math.max(0, Math.min(1, this.value));
  }

  private applyDecay(): void {
    const elapsed = now - this.lastDecayAt;
    this.value *= Math.exp((-elapsed * Math.LN2) / this.halfLifeMs);  // 600ms
  }
}

export function pressureToInterval(level: number, slowMs = 80, fastMs = 28): number {
  return Math.round(slowMs - level * (slowMs - fastMs));
}
```

**Usage:**
- Spinner frame rate adapts to event frequency
- Idle: 80ms per frame
- High load: 28ms per frame
- Visual feedback for system activity

### 6.2 Chunk Buffering

**Streaming Output Management:**
```typescript
// From cli/prompt-console.ts
const CHUNK_ACCUMULATOR_MAX_CHARS = 500;
const CHUNK_TAIL_MAX_CHARS = 120;

handleChunk(text: string): void {
  this.pressure.pulse();  // Signal activity
  // ... append to accumulator
  // Limit retained tail to prevent memory growth
}
```

**SSE Frame Parsing:**
```typescript
// From strategies/remote-session.ts
res.on("data", (chunk: Buffer) => {
  buf += chunk.toString();
  const frames = buf.split("\n\n");
  buf = frames.pop() ?? "";  // Keep incomplete frame in buffer
  for (const frame of frames) {
    // Process complete frames only
  }
});
```

### 6.3 Resource Metering & Profiling

**Performance Metrics Collection:**
```typescript
// From resource-meter.ts
const toolStats = new Map<string, ToolStats>();
const latencies: number[] = [];

function recordToolEnd(name: string, elapsedMs: number, ok: boolean) {
  existing.calls++;
  if (!ok) existing.errors++;
  existing.totalMs += elapsedMs;
  if (elapsedMs > existing.maxMs) existing.maxMs = elapsedMs;
  toolStats.set(name, existing);
  latencies.push(elapsedMs);
}

function summary() {
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  return {
    session: { elapsedMs, turns, tokensIn, tokensOut, estimatedCostUsd },
    tools: { totalCalls, totalErrors, p50Ms, p95Ms, p99Ms },
    topTools: [...toolStats.entries()]
      .sort(([, a], [, b]) => b.calls - a.calls)
      .slice(0, 10)
  };
}
```

**Percentile Calculation:**
```typescript
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
```

### 6.4 Batch Session Loading

**Pagination for Large Session Lists:**
```typescript
// From cli/session-picker.ts
const BATCH = 20;
const batch = sessions.slice(0, BATCH);  // First 20 only

// Parallel name resolution
const names = await Promise.all(batch.map((s) => fn(s.id)));
```

---

## 7. Bottlenecks & Limitations

### 7.1 Identified Performance Constraints

1. **No Request Rate Limiting**
   - HTTP router accepts unbounded concurrent requests
   - Could saturate memory with concurrent SSE connections
   - No backpressure mechanism for event observers

2. **Single-Threaded Execution**
   - CPU-bound tools (embedding generation, code analysis) block event loop
   - No worker thread pool for parallel tool execution

3. **Unbounded Event History**
   - Fixed 500-event ring buffer per HTTP session
   - Memory grows linearly with active SSE clients

4. **No Tool Cancellation**
   - `CorpusHandlerCtx` lacks `AbortSignal` parameter
   - Tools run to completion even after turn abortion
   - 30s kill timer for `fd` subprocess is the only safeguard

5. **Synchronous File Operations**
   - `alef-pm.ts` uses `readFileSync`, `writeFileSync` extensively
   - Blocks event loop during package manager operations

### 7.2 Memory Management Gaps

**No Explicit Memory Limits:**
- Tool output accumulation unbounded
- Subagent reply buffers grow without cap
- Inner tool call maps not pruned during long sessions

**Potential Leaks:**
```typescript
// From cli/tui-state.ts
export interface TuiState {
  activeCalls: Map<string, ActiveCall>;     // Never pruned mid-session
  validationErrors: Map<string, string[]>;  // Grows with errors
  exitCodes: Map<string, number>;           // Retained indefinitely
  innerReplies: Map<string, string>;        // No cleanup after batch
}
```

### 7.3 Concurrency Hazards

**Race Condition in Handoff:**
- 5s timeout vs ACK arrival
- Old green may continue serving while new green boots
- No mutual exclusion on shared state

**Observer Set Modification:**
```typescript
// From assemble.ts
for (const obs of observers) obs(agentEvent);
// Could fail if observer.add/delete called during iteration
```

---

## 8. Recommendations

### 8.1 Short-Term Improvements

1. **Add Backpressure to SSE Streams**
   ```typescript
   if (observers.size > MAX_OBSERVERS) {
     res.statusCode = 503;
     res.end("Too many active connections");
     return;
   }
   ```

2. **Implement Tool Cancellation**
   ```typescript
   export interface ToolContext {
     signal: AbortSignal;  // Add to CorpusHandlerCtx
   }
   ```

3. **Memory-Bound Event History**
   ```typescript
   const MAX_HISTORY_BYTES = 10 * 1024 * 1024;  // 10MB
   while (estimateSize(history) > MAX_HISTORY_BYTES) {
     history.shift();
   }
   ```

4. **Async File Operations in alef-pm**
   ```typescript
   import { readFile, writeFile } from "node:fs/promises";
   // Replace all sync operations
   ```

### 8.2 Long-Term Enhancements

1. **Worker Pool for CPU-Bound Tools**
   - Use `@dpopsuev/alef-worker` (if exists) or Piscina
   - Offload embeddings, code analysis, heavy parsing

2. **Adaptive Rate Limiting**
   ```typescript
   const limiter = new SlidingWindowLimiter({
     maxRequests: 100,
     windowMs: 60_000,
   });
   ```

3. **Session State Compaction**
   - Periodic VACUUM of sqlite session store
   - Prune old event log entries beyond retention window

4. **Streaming Response Budget**
   ```typescript
   export interface StreamingConfig {
     maxChunkSize: number;     // 1KB default
     maxBufferedChunks: number; // 50 chunks
     dropStrategy: "oldest" | "random";
   }
   ```

### 8.3 Monitoring & Observability

**Add Metrics:**
```typescript
export interface AgentMetrics {
  activeTurns: Gauge;
  activeSSEClients: Gauge;
  toolLatencyHistogram: Histogram;
  memoryUsageMB: Gauge;
  eventLoopLag: Gauge;
}
```

**Health Check Enhancements:**
```typescript
router.get("/health", (req, res) => {
  const health = {
    ok: true,
    metrics: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      eventLoopLag: /* measure */,
      activeSessions: sessionCount,
    }
  };
  res.json(health);
});
```

---

## 9. Testing Coverage

### 9.1 Performance-Related Tests

**Concurrency:**
- `concurrent-prompts.test.ts`: Sequential turn handling
- `agent-run-timeout.test.ts`: Timeout hierarchy verification

**Lifecycle:**
- `lifecycle-supervisor.test.ts`: IPC handoff protocol
- `supervisor-lifecycle.test.ts`: Service completion signaling

**Resource Management:**
- `loop-detector.test.ts`: Circuit breaker thresholds
- No explicit memory leak tests (gap)

### 9.2 Missing Test Coverage

1. **Load Testing:**
   - No stress tests for concurrent HTTP requests
   - No SSE connection saturation tests

2. **Resource Exhaustion:**
   - No tests for OOM conditions
   - No event queue overflow scenarios

3. **Long-Running Sessions:**
   - No multi-hour session stability tests
   - No memory growth profiling

---

## 10. Conclusion

The `packages/agent` architecture demonstrates **mature process lifecycle management** with:
- Robust cleanup via dispose pattern
- Graceful shutdown handling
- Supervisor-based service orchestration
- Token budget enforcement
- Loop detection circuit breaker

**Performance strengths:**
- Event-driven concurrency model
- Adaptive UI responsiveness (event pressure gauge)
- Bounded resource tracking (token budgets, turn limits)
- Generation-based package GC

**Areas for improvement:**
- No request rate limiting
- Single-threaded CPU bottleneck
- Unbounded event history growth
- Missing tool cancellation support
- Synchronous file I/O in package manager

The codebase prioritizes **correctness and developer experience** over raw throughput, which aligns with its CLI/TUI use case. For production deployment at scale, implementing the recommended backpressure, worker pools, and memory bounds would be essential.
