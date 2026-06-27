# Performance Analysis: packages/tools/*

## Executive Summary

The tools packages demonstrate **production-grade I/O performance patterns** with sophisticated handling of streaming, timeouts, resource cleanup, and backpressure. Key findings:

- ✅ **Streaming-first architecture** for shell execution with AsyncIterable patterns
- ✅ **Multi-layered timeout enforcement** with graceful degradation (SIGTERM → SIGKILL)
- ✅ **Write serialization queues** prevent concurrent file corruption
- ✅ **Resource cleanup** via AbortSignal propagation and finally blocks
- ⚠️ **Limited explicit backpressure** - relies on Node.js stream buffering
- ⚠️ **No rate limiting** on external process spawning

---

## 1. I/O Patterns

### 1.1 Filesystem (`packages/tools/fs`)

**Atomic Writes with Temp Files**
```typescript
// fs-utils.ts - Write-rename pattern prevents partial reads
export async function atomicWrite(dest: string, content: string): Promise<void> {
  const tmp = `${dest}.tmp.${randomUUID()}`;
  try {
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, dest);  // Atomic on POSIX
  } catch (err) {
    await unlink(tmp).catch(() => {});  // Cleanup on failure
    throw err;
  }
}
```

**Performance characteristics:**
- ✅ Prevents torn reads during concurrent writes
- ✅ UUID-based temp files avoid conflicts
- ⚠️ No fsync - relies on OS write-back caching
- ⚠️ Extra disk I/O for large files

**Write Queue - Per-Path Serialization**
```typescript
// write-queue.ts - Mutex per absolute path
export function makeWriteQueue() {
  const queues = new Map<string, Promise<void>>();
  
  return async function withQueue<T>(absolutePath: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(absolutePath) ?? Promise.resolve();
    let resolve!: () => void;
    const gate = new Promise<void>((res) => { resolve = res; });
    queues.set(absolutePath, gate);
    
    try {
      await prev;  // Wait for previous write on this path
      return await fn();
    } finally {
      resolve();  // Unblock next write
      if (queues.get(absolutePath) === gate) queues.delete(absolutePath);
    }
  };
}
```

**Throughput analysis:**
- ✅ Parallel writes to different files (no global lock)
- ✅ Sequential writes to same file (prevents corruption)
- ⚠️ No timeout on queue wait (stalled write blocks forever)
- ⚠️ Unbounded queue depth (memory leak if writes pile up)

### 1.2 Shell Execution (`packages/tools/shell`)

**Streaming Output via AsyncIterable**
```typescript
// adapter.ts - Zero-copy streaming to LLM
async function* streamExec(ctx, opts): AsyncIterable<Record<string, unknown>> {
  const child = spawn(shellCfg.shell, args, { cwd, env });
  
  for await (const buf of pushQueue<Buffer>((push, done) => {
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("close", (code) => { exitCode = code ?? 0; done(); });
  })) {
    chunks.push(buf);
    yield { chunk: buf.toString("utf-8") };  // Stream to LLM incrementally
  }
  
  const raw = Buffer.concat(chunks).toString("utf-8");
  yield { output: truncateTail(raw).content, exitCode };
}
```

**Performance characteristics:**
- ✅ **Incremental streaming** - LLM sees output immediately
- ✅ **Backpressure-aware** - AsyncIterable pauses when consumer is slow
- ✅ **Combined stdout/stderr** - single stream simplifies consumption
- ⚠️ **Memory accumulation** - chunks array holds full output for final event

**Async Push Queue Pattern**
```typescript
// Converts Node.js event callbacks to AsyncIterable
async function* pushQueue<T>(register: (push, done) => void): AsyncIterable<T> {
  const queue: T[] = [];
  let notify: (() => void) | null = null;
  const state = { finished: false };
  
  register(
    (item) => { queue.push(item); notify?.(); },
    () => { state.finished = true; notify?.(); }
  );
  
  while (!state.finished || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((r) => { notify = r; });  // Suspend until data
      notify = null;
    }
    while (queue.length > 0) yield queue.shift() as T;
  }
}
```

**Backpressure analysis:**
- ✅ **Consumer-driven** - only reads when `for await` pulls
- ⚠️ **Unbounded buffer** - if child writes faster than consumer reads, queue grows
- ⚠️ **No high-water mark** - no pause/resume on child streams

### 1.3 Web Fetching (`packages/tools/web`)

**HTTP with AbortController**
```typescript
// adapter.ts - Timeout via AbortSignal
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs ?? defaultTimeoutMs);

try {
  response = await fetch(url, {
    signal: controller.signal,
    headers: { "User-Agent": "Alef/1.0", Accept: "text/html" },
    redirect: "follow"
  });
} finally {
  clearTimeout(timer);
}
```

**Performance characteristics:**
- ✅ **AbortSignal propagation** - fetch() cancels on timeout
- ✅ **Session-scoped LRU cache** - avoids redundant fetches
- ⚠️ **No retry logic** - transient errors fail immediately
- ⚠️ **No connection pooling** - each fetch is isolated

**Cache Implementation**
```typescript
// @dpopsuev/web-spider SpiderCache (referenced)
const cache = new SpiderCache({ 
  maxSize: 50,           // LRU eviction after 50 entries
  ttlMs: 30 * 60 * 1000  // 30-minute freshness
});
```

---

## 2. Timeout Handling

### 2.1 Shell - Multi-Layer Enforcement

**Hard Timeout (SIGTERM → SIGKILL escalation)**
```typescript
// adapter.ts - Wall-clock deadline
if (timeoutMs !== undefined) {
  sigkillTimer = setTimeout(() => {
    timeout$.timedOut = true;
    child.kill("SIGTERM");  // Graceful shutdown
    sigkillTimer2 = setTimeout(() => child.kill("SIGKILL"), 5000);  // Escalate
  }, timeoutMs);
}
```

**CPU Stall Detection** (/proc-based)
```typescript
// Detects zombie processes that aren't using CPU
if (child.pid) {
  let lastCpuTime = -1, stallCount = 0;
  stallTimer = setInterval(() => {
    const stat = readFileSync(`/proc/${child.pid}/stat`, "utf-8");
    const cpuTime = utime + stime;
    if (lastCpuTime >= 0 && cpuTime === lastCpuTime) {
      stallCount++;
      if (stallCount >= 6) child.kill("SIGTERM");  // 60s of no CPU
    } else stallCount = 0;
    lastCpuTime = cpuTime;
  }, 10_000);
}
```

**Performance impact:**
- ✅ **Catches hung processes** that don't respond to wall-clock timeout
- ✅ **Gradual escalation** gives processes time to cleanup
- ⚠️ **Linux-specific** - /proc filesystem required
- ⚠️ **10s polling interval** - wastes CPU on idle processes

### 2.2 LSP Client - Request Timeouts

```typescript
// code-intel/src/lsp-client.ts
private _request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
  const id = this.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`LSP timeout: ${method}`));
    }, timeoutMs);
    
    this.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    });
    this._send(method, params, id);
  });
}
```

**Performance characteristics:**
- ✅ **Per-request timeout** - one slow request doesn't block others
- ✅ **Cleanup on settle** - prevents timer leak
- ⚠️ **No backoff** - failed requests retry at same rate

### 2.3 External Process Timeouts (find/grep)

**Watchdog Pattern**
```typescript
// fs/src/find-query.ts - fd subprocess
const fdWatchdog = new Watchdog(30_000, () => {
  stopChild?.();
  reject(new Error("fd timed out after 30s"));
});
fdWatchdog.start();

rl.on("line", (line) => {
  fdWatchdog.reset();  // Reset on activity
  lines.push(line);
});

child.on("close", () => {
  fdWatchdog.stop();  // Stop on completion
  // ... process results
});
```

**Advantages:**
- ✅ **Activity-based** - timeout only if no output for N seconds
- ✅ **Prevents premature kills** on slow but active operations
- ⚠️ **Watchdog is not cancelable** - no AbortSignal integration

---

## 3. Resource Cleanup

### 3.1 AbortSignal Propagation

**Find Query - Cancellation Chain**
```typescript
// fs/src/find-query.ts
export async function executeFindQuery(input, options): Promise<FindToolResponse> {
  const signal = options.signal;
  signal?.throwIfAborted();  // Pre-check
  
  return new Promise((resolve, reject) => {
    let stopChild: (() => void) | undefined;
    
    const onAbort = () => {
      stopChild?.();
      settle(() => reject(new Error("Operation aborted")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    
    // ... spawn child process
    stopChild = () => {
      if (!child.killed) child.kill();
    };
    
    child.on("close", () => {
      signal?.removeEventListener("abort", onAbort);  // Cleanup listener
      // ...
    });
  });
}
```

**Cleanup guarantees:**
- ✅ **Listener deregistration** - prevents memory leaks
- ✅ **Process kill on abort** - no orphaned children
- ⚠️ **No cleanup timeout** - kill() doesn't guarantee process death

### 3.2 Finally Blocks for Timers

**Shell Adapter**
```typescript
try {
  for await (const buf of pushQueue(...)) {
    yield { chunk: buf.toString("utf-8") };
  }
} finally {
  if (sigkillTimer) clearTimeout(sigkillTimer);
  if (sigkillTimer2) clearTimeout(sigkillTimer2);
  if (stallTimer) clearInterval(stallTimer);
}
```

**Benefits:**
- ✅ **Always executes** - even on exception/early return
- ✅ **Multiple cleanups** - handles all timers atomically
- ⚠️ **No child process cleanup** - child might keep running

### 3.3 Process Tree Cleanup

**Shell Process Tree Killer**
```typescript
// shell/src/process-tree.ts
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { detached: true });
  } else {
    try {
      process.kill(-pid, "SIGKILL");  // Kill process group
    } catch {
      process.kill(pid, "SIGKILL");   // Fallback to PID only
    }
  }
}
```

**Cross-platform handling:**
- ✅ **Process group kill** on Unix (negative PID)
- ✅ **Tree kill** on Windows via taskkill /T
- ⚠️ **No verification** - doesn't check if processes died

### 3.4 LSP Client Shutdown

**Graceful Shutdown Sequence**
```typescript
// code-intel/src/lsp-client.ts
async stop(): Promise<void> {
  if (!this.ready) return;
  try {
    await this._request("shutdown", null, 3_000);  // Graceful
    this._send("exit", null);                      // Final notification
  } catch {
    /* ignore timeout on shutdown */
  }
  this.proc.kill();  // Force kill as fallback
  this.pending.clear();
}
```

**Shutdown robustness:**
- ✅ **LSP protocol compliance** - shutdown → exit sequence
- ✅ **Timeout on graceful** - doesn't hang forever
- ✅ **Force kill fallback** - always terminates
- ⚠️ **No SIGTERM → SIGKILL escalation** - kill() is immediate SIGTERM

---

## 4. Backpressure & Flow Control

### 4.1 Shell Streaming - Implicit Backpressure

**AsyncIterable automatically pauses on slow consumer:**
```typescript
for await (const buf of pushQueue<Buffer>(...)) {
  yield { chunk: buf.toString("utf-8") };  // Yield blocks if consumer is slow
}
```

**Backpressure flow:**
1. Consumer (kernel bus) is busy processing previous event
2. `yield` suspends generator until next `next()` call
3. `pushQueue` buffer accumulates chunks during suspension
4. Once consumer ready, generator resumes and drains buffer

**Analysis:**
- ✅ **Natural flow control** - no manual pause/resume
- ⚠️ **Unbounded buffer** - pushQueue queue can grow indefinitely
- ⚠️ **No child.stdout.pause()** - child keeps writing to buffer

### 4.2 File Query Backpressure

**Grep/Find limit enforcement:**
```typescript
// fs/src/grep-query.ts
rl.on("line", (line) => {
  if (matchCount >= effectiveLimit) return;  // Stop consuming
  
  matchCount++;
  matches.push(parsed);
  
  if (matchCount >= effectiveLimit) {
    matchLimitReached = true;
    stopChild(true);  // Kill subprocess early
  }
});
```

**Benefits:**
- ✅ **Early termination** - kills `rg` when limit reached
- ✅ **Memory bounded** - matches array capped at limit
- ⚠️ **No consumer feedback** - doesn't check if LLM can handle results

### 4.3 No Explicit Backpressure on HTTP

**Web adapter reads response fully:**
```typescript
const rawText = await response.text();  // Buffers entire response
```

**Token budget truncation (post-fetch):**
```typescript
const spiderOpts: SpiderOptions = {
  timeoutMs,
  ...(tokenBudget !== undefined ? { tokenBudget } : {})
};
const page = await spider(url, spiderOpts);  // Truncates after parsing
```

**Analysis:**
- ⚠️ **No streaming truncation** - downloads full page before truncating
- ⚠️ **Memory spike** for large pages
- ✅ **Post-processing truncation** prevents oversized LLM context

---

## 5. Caching Strategies

### 5.1 File Query Cache (TTL-based)

**LRU with time-based eviction:**
```typescript
// fs/src/cache.ts
export class InMemoryToolResultCache {
  private readonly _ttlMs = 10_000;           // 10s freshness
  private readonly _maxEntries = 256;         // LRU cap
  
  get(key: string): CacheHit | undefined {
    const now = Date.now();
    this._evictExpired(now);  // Cleanup on every get
    
    const entry = this._entries.get(key);
    if (entry && entry.expiresAt > now) {
      // Move to end (LRU)
      this._entries.delete(key);
      this._entries.set(key, entry);
      return { value: entry.value, ageMs: now - entry.createdAt, ttlMs: this._ttlMs };
    }
    return undefined;
  }
}
```

**Cache key structure:**
```typescript
// fs/src/grep-query.ts
function makeGrepCacheKey(input): string {
  return JSON.stringify({
    v: 1,  // Schema version
    tool: "file_grep",
    pattern, searchPath, glob, ignoreCase, literal, context, limit, type
  });
}
```

**Performance characteristics:**
- ✅ **Invalidation-free** - TTL expires automatically
- ✅ **LRU eviction** - keeps hot entries
- ⚠️ **Eager eviction on get()** - O(n) scan on every access
- ⚠️ **No size-based eviction** - large results count same as small

### 5.2 Web Spider Cache (Session-scoped)

**30-minute LRU:**
```typescript
const cache = new SpiderCache({ 
  maxSize: 50, 
  ttlMs: 30 * 60 * 1000 
});

const cacheKey = url;
const cached = cache.get(cacheKey);
if (cached) return cached;

const page = await spider(url, spiderOpts);
cache.set(cacheKey, page);
```

**Analysis:**
- ✅ **URL-based key** - simple and effective
- ✅ **Long TTL** - assumes web content is stable during session
- ⚠️ **No conditional GET** - ignores HTTP ETags/Last-Modified
- ⚠️ **No cache warming** - first access always waits

---

## 6. Concurrency & Parallelism

### 6.1 File Tracker - Read/Write Staleness Detection

**Prevents edit-after-modify race:**
```typescript
// fs/src/file-tracker.ts
export class FileTracker {
  private readonly reads = new Map<string, number>();   // path → timestamp
  private readonly writes = new Map<string, number>();  // path → timestamp
  
  record(absolutePath: string): void {
    this.reads.set(absolutePath, Date.now());
  }
  
  recordWrite(absolutePath: string, previousContent?: string): void {
    this.writes.set(absolutePath, Date.now());
    if (previousContent) this.snapshots.set(absolutePath, previousContent);
  }
}
```

**Enforced in edit handler:**
```typescript
const lastReadAt = tracker.lastReadAt(absolutePath);
if (lastReadAt === undefined) {
  throw new Error("File not read this session. Use fs.read first.");
}

const mtimeMs = fileStat.mtimeMs;
if (mtimeMs > lastReadAt) {
  throw new Error(`File modified after last read. Re-read before editing.`);
}
```

**Concurrency guarantees:**
- ✅ **Detects external edits** - formatter/IDE changes trigger re-read
- ✅ **Session-scoped** - prevents cross-session confusion
- ⚠️ **No file locking** - concurrent edits from multiple agents race
- ⚠️ **Timestamp precision** - 1ms granularity (mtime is ms)

### 6.2 Write Queue - Per-Path Mutex

**Prevents same-file write conflicts:**
```typescript
// Usage in adapter
const absolutePath = nodeResolve(options.cwd, ctx.payload.path);
const result = await withQueue(absolutePath, () => handleWrite(ctx, options, tracker));
```

**Throughput characteristics:**
- ✅ **Parallel writes** to different files
- ✅ **Sequential writes** to same file
- ⚠️ **No read-write coordination** - reads can happen during writes
- ⚠️ **No deadlock detection** - circular dependencies deadlock

### 6.3 LSP Client - Single Subprocess Per Workspace

**Shared across all code-intel calls:**
```typescript
// code-intel/src/local-backend.ts
export class LocalCodeIntelBackend {
  private lsp: LspClient | null = null;
  
  async warmUp(): Promise<void> {
    if (!this.lsp) this.lsp = await LspClient.start(this.cwd);
  }
  
  async stopLsp(): Promise<void> {
    await this.lsp?.stop();
    this.lsp = null;
  }
}
```

**Concurrency model:**
- ✅ **Single server** - avoids duplicate TypeScript indexing
- ✅ **Multiplexed requests** - pending map handles concurrent calls
- ⚠️ **No connection pooling** - one crashed LSP blocks all code-intel

---

## 7. Sandboxing & Isolation (Enclosure)

### 7.1 Docker-based Isolation

**Resource limits via cgroups:**
```typescript
// enclosure/src/adapter.ts
const EXEC_TOOL = {
  inputSchema: z.object({
    confine: z.boolean().optional(),
    memoryMaxBytes: z.number().optional(),
    cpuQuotaUs: z.number().optional()
  })
};
```

**Implementation (Docker backend):**
- ✅ **CPU quotas** - prevents runaway processes
- ✅ **Memory limits** - OOM kills contained
- ✅ **Network isolation** - --network=none by default
- ⚠️ **No disk I/O limits** - can saturate storage
- ⚠️ **No process count limit** - fork bombs possible

### 7.2 OverlayFS (Linux)

**Copy-on-write workspace:**
```typescript
// Space.workDir() returns overlay mount point
// Reads from lower (real workspace)
// Writes to upper (ephemeral overlay)
```

**Performance:**
- ✅ **Zero-copy reads** - lower layer is read-only
- ✅ **Instant snapshots** - copy overlay directory
- ⚠️ **No quota enforcement** - overlay can fill disk

---

## 8. Performance Bottlenecks & Recommendations

### 8.1 Critical Issues

**1. Unbounded Buffers in Streaming**
```typescript
// shell/src/adapter.ts - ISSUE: chunks array grows unbounded
const chunks: Buffer[] = [];
for await (const buf of pushQueue<Buffer>(...)) {
  chunks.push(buf);  // Memory leak for long-running processes
  yield { chunk: buf.toString("utf-8") };
}
```

**Recommendation:**
```typescript
// Option 1: Circular buffer (fixed size)
const chunks = new CircularBuffer(maxSize);

// Option 2: Don't accumulate (stream-only mode)
for await (const buf of pushQueue<Buffer>(...)) {
  yield { chunk: buf.toString("utf-8") };
}
// Final event has truncated output from temp file
```

**2. No Backpressure on Child Process Streams**
```typescript
// MISSING: child.stdout.pause() when consumer is slow
child.stdout.on("data", push);  // Always pushes to queue
```

**Recommendation:**
```typescript
const rl = createInterface({ 
  input: child.stdout,
  crlfDelay: Infinity
});
rl.on("line", (line) => {
  if (queue.length > HIGH_WATER_MARK) {
    child.stdout.pause();  // Apply backpressure
  }
  push(line);
});
```

**3. Write Queue Has No Timeout**
```typescript
// ISSUE: Stalled write blocks all subsequent writes to same file forever
await prev;  // No timeout
```

**Recommendation:**
```typescript
const timeoutPromise = new Promise((_, rej) => 
  setTimeout(() => rej(new Error("Write queue timeout")), 30_000)
);
await Promise.race([prev, timeoutPromise]);
```

### 8.2 Optimization Opportunities

**1. LSP Client Connection Pooling**
- **Current:** One LSP server per workspace, crashes block all code-intel
- **Proposal:** Pool of N servers, failed requests retry on different instance

**2. Grep/Find Result Streaming**
- **Current:** Accumulates all matches, then returns
- **Proposal:** Stream matches to LLM incrementally (like shell.exec)

**3. File Read Cache Warming**
- **Current:** Cold cache on every session start
- **Proposal:** Pre-warm cache with likely-accessed files (package.json, tsconfig.json)

**4. HTTP Connection Reuse**
- **Current:** Each web.fetch creates new connection
- **Proposal:** HTTP agent with keep-alive connection pooling

---

## 9. Test Coverage

### 9.1 Timeout Tests

```typescript
// shell/test/timeout.test.ts
describe("shell timeout clamping", () => {
  it("default timeout is 300s", () => {
    expect(DEFAULT_SHELL_TIMEOUT_S).toBe(300);
  });
  
  it("max timeout cap is 600s", () => {
    expect(MAX_SHELL_TIMEOUT_S).toBe(600);
  });
});
```

### 9.2 Cleanup Tests

```typescript
// mcp-registry/test/mcp-adapter.test.ts
it("unmount closes the MCP client", async () => {
  const adapter = createMcpAdapter(client);
  adapter.mount(bus.asBus());
  
  await adapter.close?.();
  expect(client.close).toHaveBeenCalledOnce();
});
```

### 9.3 Streaming Tests

```typescript
// shell/test/adapter.test.ts
it("executes command and streams Event/shell.exec, final has output", async () => {
  const final = await fixture.callStreaming("shell.exec", { command: "echo hello" });
  expect(final.isError).toBe(false);
  expect(final.payload.isFinal).toBe(true);
  expect(final.payload.output).toContain("hello");
});
```

---

## 10. Conclusion

### Strengths

1. **Sophisticated streaming** - AsyncIterable + pushQueue is elegant
2. **Multi-layer timeouts** - Hard deadlines + activity watchdogs
3. **Resource cleanup** - Finally blocks + AbortSignal propagation
4. **Atomic writes** - Temp file + rename prevents corruption
5. **Process tree cleanup** - Cross-platform SIGKILL propagation

### Weaknesses

1. **No explicit backpressure** - Child process streams don't pause
2. **Unbounded buffers** - Memory leaks on long-running operations
3. **No rate limiting** - Can spawn unlimited concurrent processes
4. **Limited error recovery** - No retry logic on transient failures
5. **No disk I/O limits** - Sandboxed processes can fill disk

### Performance Rating

| Aspect | Rating | Notes |
|--------|--------|-------|
| **Streaming** | 🟢 Excellent | AsyncIterable with incremental yield |
| **Timeouts** | 🟢 Excellent | Multi-layer enforcement (wall-clock + stall detection) |
| **Cleanup** | 🟢 Excellent | Finally blocks + AbortSignal + process tree kill |
| **Backpressure** | 🟡 Fair | Implicit via AsyncIterable, no explicit pause/resume |
| **Concurrency** | 🟢 Excellent | Per-path write queues, LSP multiplexing |
| **Caching** | 🟡 Fair | LRU + TTL, but eager eviction on every get() |
| **Sandboxing** | 🟢 Excellent | Docker + OverlayFS + cgroups |
| **Memory** | 🟡 Fair | Unbounded stream buffers, no size limits |

### Overall Assessment

**This is production-quality code** with clear attention to edge cases and failure modes. The main gaps are around explicit backpressure and bounded buffers - areas where Node.js defaults handle 90% of cases but can surprise under load.

The multi-layer timeout strategy (hard deadline + stall detection + SIGTERM→SIGKILL) is particularly impressive and shows deep understanding of Unix process lifecycle.
