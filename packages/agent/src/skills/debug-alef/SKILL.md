---
name: debug-alef
description: Use when debugging Alef itself — hung tools, TUI glitches, LLM loop issues, session corruption, adapter failures, fs.find hangs. Use ONLY for debugging the Alef agent codebase at /home/dpopsuev/Workspace/alef, not for debugging user applications.
---

# Debugging Alef

## Architecture overview

Alef uses a Supervisor-as-entrypoint model. One process, everything is a service.

```
Supervisor (entrypoint.ts)
  ├── storage service     — SQLite DB lifecycle
  ├── scheduler service   — deferred/recurring timers
  ├── session service     — Session mediator (Observer+Mediator pattern)
  ├── agent service       — daemon registration, HTTP surface
  └── tui service         — ViewMode lifecycle, done promise
```

Boot: `bin/alef.js` → `entrypoint.ts` → CLI dispatch (early exit) → Supervisor boot.
No child process. No IPC. The Supervisor IS the process.

## Log system overview

All logging is unified under session storage. One session per ID, structured records, one activation knob.

**Storage:** SQLite at `~/.alef/alef.db` (tables: `sessions`, `events`, `daemon`)

**Record schema:**
```json
{"bus":"debug","type":"boot","correlationId":"debug","payload":{"pid":12345,"cwd":"/path","model":"claude-sonnet-4-5","tui":true},"timestamp":1719000000000}
```

Buses: `command` (tool commands), `event` (tool results), `notification` (telemetry), `debug` (lifecycle/diagnostics).

**Activation:**
- `--debug` flag — sets pino level to `debug`, all events visible on stderr
- `ALEF_DEBUG=1` — identical to `--debug`
- No flag — debug events still land in session JSONL, but pino stderr output is warn-level only

## Bus auto-tracing (zero boilerplate)

`InProcessBus({ trace: true })` subscribes wildcard listeners on all 3 channels. Every message flowing through the bus is traced with type + correlationId + elapsed. No per-call-site instrumentation needed.

Bus auto-trace events:
```
bus:command:llm.input          — user message published
bus:command:llm.response       — LLM reply published
bus:notification:llm.chunk     — streaming chunk
bus:notification:llm.thinking  — thinking chunk
bus:notification:llm.tool-start — tool call dispatched
bus:notification:llm.tool-end  — tool result received
bus:event:fs.read              — tool command on event bus
```

Query all bus events for a session:
```bash
sqlite3 ~/.alef/alef.db "SELECT type, json_extract(payload,'$.correlationId') as cid, json_extract(payload,'$.elapsed') as ms FROM events WHERE session_id='SESSION_ID' AND type LIKE 'bus:%' ORDER BY timestamp"
```

## AsyncLocalStorage trace context

`traceEvent()` automatically enriches events with `correlationId` and `turn` from the current async context when `runInTraceContext()` is active. No parameter passing needed.

```ts
import { traceEvent, runInTraceContext } from "@dpopsuev/alef-kernel/log";

runInTraceContext({ correlationId: "abc-123", turn: 1 }, () => {
  traceEvent("my:event", { custom: "data" });
  // → automatically includes correlationId: "abc-123", turn: 1
});
```

## alef store — session query CLI

Built-in CLI for querying the SQLite session store. No raw SQL needed.

### Subcommands

```bash
alef store sessions                      # list sessions (newest first)
alef store sessions --search "refactor"  # search by name/ID
alef store events <id>                   # all events in a session
alef store trace <id> <correlationId>    # one turn's full trace
alef store summary <id>                  # token/tool/error summary
alef store summary                       # latest session summary
alef store tail                          # latest session events
```

### Composable filters (any combination)

```bash
alef store events <id> --bus notification          # filter by bus
alef store events <id> --type 'llm.%'              # filter by type pattern
alef store events <id> --adapter fs                # filter by adapter prefix
alef store events <id> --after 22:30 --before 22:35  # time window
alef store events <id> --corr e9f1                 # correlationId prefix
alef store events <id> --errors                    # errors only
alef store events <id> --payload "Cannot read"     # payload substring
alef store events <id> --limit 5                   # max results
alef store events <id> --json                      # JSON output for piping
alef store tail --adapter llm --limit 10           # filters work on tail too
```

### Common debugging workflows

```bash
# Find the crash: which session had errors?
alef store sessions

# What errors happened in session bfd457a7?
alef store events bfd457a7 --errors

# Trace a specific turn by correlationId
alef store trace bfd457a7 e9f102f1

# Find all tool calls in a session
alef store events bfd457a7 --type 'llm.tool-%'

# Find events containing specific text
alef store events bfd457a7 --payload "Cannot read properties"

# Get JSON for piping to jq
alef store tail --json | jq '.type'
```

## Start here

```bash
# List sessions
alef store sessions

# Inspect most recent session (tool-call pairing analysis)
alef debug session

# All errors in a session
alef store events <id> --errors

# Trace a specific turn
alef store trace <id> <correlationId>
```

## Message round-trip

Full lifecycle of a user message:

```
User types → Enter
  1. editor.onSubmit        (tui-submit.ts)
  2. session.send()         (SessionHandle → AgentController)
  3. bus command/llm.input   (agent publishes to bus)
  4. Reasoner handles it    (createAgentLoop subscribed to event/llm.input)
  5. HTTP stream to LLM     (callLLM → provider)
  6. Chunks stream back     (bus notification/llm.chunk for each)
  7. connectObservers       (assemble.ts converts bus events → AgentEvent)
  8. session.subscribe      (TUI dispatch receives events)
  9. tui.requestRender()    (TUI repaints terminal)
 10. bus command/llm.response (stream ends, reply published)
 11. AgentController.handleReply resolves the pending promise
 12. session.send() promise resolves
```

With bus auto-trace enabled, steps 3, 6, 10 are traced automatically. No manual instrumentation.

**Hang diagnosis:**
- `bus:command:llm.input` without `bus:command:llm.response` = LLM call failed or hung
- Chunks stream but TUI doesn't render = check glyph registry for missing keys (GlyphKey union type prevents this at compile time now)
- `llm.tool-end` with `ok:false` = tool result rendering crashed

## Event reference

### Lifecycle (bus: "debug")

| type | Key fields | What it means |
|---|---|---|
| `boot` | `pid, cwd, model, tui` | Process started |
| `tui:start` | — | TUI live, accepting input |
| `tui:stopped` | — | TUI teardown complete |
| `tool:start` | `callId, name, keyArg, activeCount` | LLM dispatched a tool call |
| `tool:end` | `callId, name, elapsedMs, ok, remainingActive` | Tool result received |
| `loop:detected` | `reason` | Loop detector fired, LLM aborted |

**Hang diagnosis:** `tool:start` without matching `tool:end` = hung tool.
`callId` correlates between them.

### LLM timing (bus: "debug", need `--debug`)

| type | Key fields | What it means |
|---|---|---|
| `llm:phase:enter` | `turn` | llm.phase pipeline fired |
| `llm:phase:exit` | `turn, elapsedMs, modified` | pipeline resolved |
| `llm:http:start` | `turn, messages, tools` | HTTP call to provider started |
| `llm:http:done` | `turn, elapsedMs, stopReason` | stream exhausted |
| `llm:http:error` | `turn, elapsedMs, abort, err` | stream threw |
| `llm:retry` | `turn, attempt, reason` | retryable error, backing off |
| `llm:tool:subscribe` | `name, toolCallId` | waitForToolResult waiting on sense bus |
| `llm:tool:resolved` | `name, elapsedMs, isError` | sense event arrived |
| `llm:tool:timeout` | `name, elapsedMs` | tool timed out |
| `llm:tool:stall` | `name, elapsedMs, lastChunkMs` | no chunks for 5s |

**LLM hang:** `llm:http:start` without `llm:http:done`.
**Tool stall:** `llm:tool:stall` fires but `llm:tool:resolved` never follows.

### Delegation boundary (bus: "debug")

| type | Key fields | What it means |
|---|---|---|
| `delegate:strategy:start` | `adapter, tool, correlationId, profile, timeoutMs` | InProcessStrategy.send() called |
| `delegate:strategy:done` | `adapter, tool, correlationId, profile, elapsedMs, ok` | Strategy completed |
| `in-process:start` | `adapters, timeoutMs` | Inner agent created |
| `in-process:done` | `replyLength` | Inner agent replied |
| `in-process:error` | `err` (full stack) | Inner agent threw |

### Framework errors (bus: "debug")

| type | Key fields | What it means |
|---|---|---|
| `stream action failed` | `op, correlationId, err` | typedStreamAction generator threw |
| `command action failed` | `op, correlationId, err` | typedAction handler threw |
| `event action failed` | `op, correlationId, err` | event-side action threw |
| `tool:schema-rejected` | `name, field, issues` | LLM passed invalid args |

### fs.find events (bus: "debug")

| type | Key fields | What it means |
|---|---|---|
| `fs:find:spawn` | `pattern, searchPath` | fd subprocess spawned |
| `fs:find:close` | `elapsedMs, code, lines, pattern` | fd exited normally |
| `fs:find:timeout` | `elapsedMs, pattern, searchPath` | 30s kill timer fired |

## Adapter handler logs (ctx.log)

Every `typedAction` and `typedStreamAction` handler receives `ctx.log` — a child logger
pre-stamped with `{ adapter, tool, correlationId, toolCallId }`.

```ts
ctx.log.warn({ path, bytes }, "file too large to read");
```

These flow through pino to stderr (suppressed in TUI mode). For persistent records,
use `traceEvent()` which writes to session JSONL.

## Diagnosing a hung fs.find

```bash
# Find tool:start without matching tool:end
jq 'select(.type == "tool:start" and .payload.name == "fs.find")' "$SESSION"
```

Reproduce the exact fd command:
```bash
fd --glob --color=never --no-require-git --max-results 1000 --hidden -- "<pattern>" "<cwd>"
```

Kill timer: `packages/tools/fs/src/find-query.ts` — fires at 30s.

## TUI frame capture (ALEF_DEBUG=1 only)

```bash
tail -f /tmp/alef-frames.jsonl | jq .frame
```

## TUI glyph crash prevention

Glyph keys are type-safe via `GlyphKey` union type. `glyph("unknown")` is a compile-time error (TS2345). If a new glyph key is needed, add it to the `GLYPHS` map in both:
- `packages/ui/tui/src/views/theme.ts`
- `packages/agent/src/cli/ansi.ts`

## Directive system

Directives are standalone XML blocks injected into the system prompt. Key blocks:
- `no-emojis` (priority 10) — no emoji in any output
- `no-files` (priority 15) — no file creation for reports/analysis, no aspirational abstractions
- `core` (priority 0) — agent identity and safety rules
- `agents-md` (priority 450) — project-specific rules from AGENTS.md

Check directives in the session JSONL:
```bash
jq 'select(.type == "directives:built") | .payload.ids' "$SESSION"
```

## Daemon debugging

When running with `--daemon`:
- Registry: SQLite table `daemon` in `~/.alef/alef.db`
- Attach: `alef --attach` connects to SSE on `http://127.0.0.1:<port>/events`

```bash
alef --list-daemons          # Show running daemons
alef --attach last            # Attach to most recent daemon
alef --kill-daemon <id>       # Stop a daemon by session ID
```

## Supervisor service debugging

```bash
# Check which services are registered
# In code: supervisor.names() → string[]
# In debug events: look for service start/stop events

# Session service is the mediator — all UI events flow through it
# Agent service manages daemon registration
# TUI service exposes done promise — resolves when viewer exits
```

## Missing instrumentation (known gaps)

1. **No AbortSignal in `CorpusHandlerCtx`** — adapters cannot be cancelled mid-flight.
   Ctrl+C aborts the LLM turn but fd subprocess runs until 30s kill timer.

## Key source files

| Concern | File |
|---|---|
| `traceEvent()` + `runInTraceContext()` | `packages/core/kernel/src/trace.ts` |
| Bus auto-trace | `packages/core/kernel/src/bus/in-process-bus.ts` (trace option) |
| Logger creation | `packages/agent/src/logger.ts` |
| `ctx.log` stamping | `packages/core/kernel/src/adapter/dispatch.ts` |
| Reasoner events | `packages/core/reasoner/src/stream-turn.ts`, `tool-dispatch.ts`, `turn-loop.ts` |
| Delegation events | `packages/core/engine/src/delegation.ts`, `in-process.ts` |
| `tools:describe:miss` | `packages/core/engine/src/tool-catalog.ts` |
| fd subprocess + kill timer | `packages/tools/fs/src/find-query.ts` |
| Session store (SQLite) | `packages/core/storage/src/factory.ts` |
| Session store (JSONL) | `packages/agent/src/session-store.ts` |
| Supervisor entrypoint | `packages/agent/src/entrypoint.ts` |
| Session service (mediator) | `packages/agent/src/session-service.ts` |
| Agent service | `packages/agent/src/agent-service.ts` |
| TUI service | `packages/agent/src/tui-service.ts` |
| Glyph registry (TUI) | `packages/ui/tui/src/views/theme.ts` |
| Glyph registry (agent) | `packages/agent/src/cli/ansi.ts` |
| Supervisor class | `packages/core/supervisor/src/supervisor.ts` |
| ServiceDescriptor / lifecycle | `packages/core/supervisor/src/lifecycle.ts` |
| Scheduler service | `packages/core/supervisor/src/scheduler.ts` |
| Package Manager service | `packages/core/supervisor/src/package-manager.ts` |
| Storage service | `packages/core/storage/src/service.ts` |
| Store CLI | `packages/agent/src/store-cli.ts` |

## Quick reference

```bash
# Sessions
alef store sessions                          # list all
alef store sessions --search "refactor"      # search

# Events (with composable filters)
alef store events <id>                       # all events
alef store events <id> --errors              # errors only
alef store events <id> --adapter llm         # LLM events
alef store events <id> --bus notification    # notification bus
alef store events <id> --payload "error"     # payload search
alef store events <id> --after 22:30         # time filter
alef store events <id> --json                # pipe to jq

# Tracing
alef store trace <id> <correlationId>        # one turn trace
alef store tail                              # latest session
alef store tail --errors                     # latest errors

# Summary
alef store summary <id>                      # session stats
alef store summary                           # latest session

# Legacy (tool-call pairing analysis)
alef debug session

# Headless capture
ALEF_DEBUG=1 alef --no-tui -p "prompt" 2>&1
```

## CLI introspection (no TUI required)

```bash
alef --preflight           # Verify config, profile, model, adapters, tools, directives
alef --list-models         # Models for active profile
alef --show-config         # Parsed config.yaml
alef --list-directives     # Directive blocks with priorities
alef --list-tools          # Loaded tools
alef --list-adapters       # Loaded adapters with labels
alef --migrate             # Import legacy JSONL sessions to SQLite
alef --replay <id|last>    # Replay recorded session (zero tokens)
alef --daemon              # Run headless, expose HTTP/SSE
alef --attach <id|last>    # Attach TUI to running daemon
alef --list-daemons        # Show running daemons
alef --kill-daemon <id>    # Stop a running daemon
alef --serve <port>        # Expose HTTP/SSE bridge on port
alef --thinking <level>    # Set extended thinking: off, low, medium, high
```

## Timeout constants

```
DEFAULT_LLM_TIMEOUT_MS    = 120s  (per-turn LLM HTTP call)
DEFAULT_TOOL_TIMEOUT_MS   = 300s  (tool execution — longer than LLM)
DEFAULT_CONVERSATION_MS   = 900s  (15 min session)
DEFAULT_STALL_TIMEOUT_MS  = 180s  (3 min inactivity)
```

Override via env: `ALEF_LLM_TIMEOUT_MS=60000 alef`
