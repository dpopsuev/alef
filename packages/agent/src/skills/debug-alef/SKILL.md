---
name: debug-alef
description: Use when debugging Alef itself — hung tools, TUI glitches, LLM loop issues, session corruption, adapter failures, fs.find hangs. Use ONLY for debugging the Alef agent codebase at /home/dpopsuev/Workspace/alef, not for debugging user applications.
---

# Debugging Alef

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

## Start here

```bash
# List sessions for current cwd
alef debug session --list

# Inspect most recent session (tool-call pairing analysis)
alef debug session

# Query session events from SQLite
sqlite3 ~/.alef/alef.db "SELECT bus, type, payload FROM events WHERE session_id='SESSION_ID' AND bus='debug' ORDER BY timestamp"

# Filter by event type
sqlite3 ~/.alef/alef.db "SELECT payload FROM events WHERE session_id='SESSION_ID' AND type='tool:start'"

# All errors
sqlite3 ~/.alef/alef.db "SELECT type, payload FROM events WHERE session_id='SESSION_ID' AND bus='debug' AND type LIKE '%error%' OR type LIKE '%failed%'"
```

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

### Tool catalog

| type | Key fields | What it means |
|---|---|---|
| `tools:describe:miss` | `name, available` | LLM asked for schema of unknown tool |

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
use `debugLog()` which writes to session JSONL.

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

If directives aren't working, check:
1. `alef --list-directives` — are no-emojis and no-files listed?
2. `jq 'select(.type == "directives:built")' "$SESSION"` — were they loaded at boot?
3. Run headless to verify: `alef --no-tui -p "what directives are loaded?" 2>&1 | grep directives`

## Daemon debugging

When running with `--daemon`:
- Registry: SQLite table `daemon` in `~/.alef/alef.db`
- Attach: `alef --attach` connects to SSE on `http://127.0.0.1:<port>/events`

```bash
alef --list-daemons          # Show running daemons
alef --attach last            # Attach to most recent daemon
alef --kill-daemon <id>       # Stop a daemon by session ID
```

## Missing instrumentation (known gaps)

1. **No AbortSignal in `CorpusHandlerCtx`** — adapters cannot be cancelled mid-flight.
   Ctrl+C aborts the LLM turn but fd subprocess runs until 30s kill timer.

## Key source files

| Concern | File |
|---|---|
| `debugLog()` + `initSessionSink()` | `packages/core/kernel/src/debug.ts` |
| Logger creation | `packages/agent/src/logger.ts` |
| `ctx.log` stamping | `packages/core/kernel/src/adapter-dispatch.ts` |
| reasoner events | `packages/core/reasoner/src/stream-turn.ts`, `tool-dispatch.ts`, `turn-loop.ts` |
| delegation events | `packages/core/runtime/src/delegation.ts`, `in-process.ts` |
| `tools:describe:miss` | `packages/core/runtime/src/tool-catalog.ts` |
| fd subprocess + kill timer | `packages/tools/fs/src/find-query.ts` |
| Session store (SQLite) | `packages/core/storage/src/session-store.ts` |
| Session store (JSONL) | `packages/core/session/src/session-store.ts` |
| Daemon registry + SSE | `packages/agent/src/build-delegation.ts` |
| AgentRuntime | `packages/agent/src/agent-runtime.ts` |

## Quick reference

```bash
# List sessions, inspect latest
alef debug session --list
alef debug session

# Query events from SQLite (replace SESSION_ID)
sqlite3 -json ~/.alef/alef.db "SELECT type, json_extract(payload,'$.name') as name, json_extract(payload,'$.elapsedMs') as ms FROM events WHERE session_id='SESSION_ID' AND type='tool:end'"

# All debug events
sqlite3 ~/.alef/alef.db "SELECT type, payload FROM events WHERE session_id='SESSION_ID' AND bus='debug' ORDER BY timestamp"

# Run headless to capture everything to terminal
ALEF_DEBUG=1 alef --no-tui -p "your prompt here" 2>&1
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

## Model profiles

Config at `~/.config/alef/config.yaml`:
```yaml
profile: work
profiles:
  work:
    providers: [anthropic, google-vertex]
    tiers:
      strong: anthropic/claude-opus-4-8
      default: anthropic/claude-sonnet-4-5
      fast: anthropic/claude-haiku-4-5
```

## Background task completion

When `agent.run({ async: true })` completes, the result is injected as a new turn via `controller.receive()`:
```bash
jq 'select(.type == "task.completed" or .type == "task.failed")' "$SESSION"
```

## Timeout constants

```
DEFAULT_LLM_TIMEOUT_MS    = 120s  (per-turn LLM HTTP call)
DEFAULT_TOOL_TIMEOUT_MS   = 300s  (tool execution — longer than LLM)
DEFAULT_CONVERSATION_MS   = 900s  (15 min session)
DEFAULT_STALL_TIMEOUT_MS  = 180s  (3 min inactivity)
```

Override via env: `ALEF_LLM_TIMEOUT_MS=60000 alef`

## Footer context %

The dashboard footer shows actual LLM context fill (from `totalTokens` in token-usage events), not cumulative session total. After compaction it drops correctly.

## New tools (June 2026)

- `fs.undo` — revert a file to pre-edit content (in-memory snapshot)
- `code.review` — capture git diff for structured review annotations
- `git.status` — working tree status
- `git.pr-create/list/review/merge` — Forgejo forge integration (requires ALEF_FORGE_URL)
