---
name: debug-alef
description: Use when debugging Alef itself — hung tools, TUI glitches, LLM loop issues, session corruption, adapter failures, fs.find hangs. Use ONLY for debugging the Alef agent codebase at /home/dpopsuev/Workspace/alef, not for debugging user applications.
---

# Debugging Alef

## Log system overview

All logging is unified under session JSONL. One file per session, structured records, one activation knob.

**Location:** `~/.alef/sessions/<cwd-hash>/<session-id>.jsonl`

**Record schema:**
```json
{"bus":"debug","type":"boot","correlationId":"debug","payload":{"pid":12345,"cwd":"/path","model":"claude-sonnet-4-5","tui":true},"timestamp":1719000000000}
```

Buses: `motor` (LLM commands), `sense` (tool results), `signal` (telemetry), `debug` (lifecycle/diagnostics).

**Activation:**
- `--debug` flag — sets pino level to `debug`, all events visible on stderr
- `ALEF_DEBUG=1` — identical to `--debug`
- No flag — debug events still land in session JSONL, but pino stderr output is warn-level only

## Start here

```bash
# Find the session JSONL for current cwd
HASH=$(echo -n $(pwd) | sha1sum | cut -c1-12)
SESSION=$(ls -t ~/.alef/sessions/$HASH/*.jsonl | head -1)

# Watch debug events live
tail -f "$SESSION" | jq 'select(.bus == "debug")'

# Filter by event type
jq 'select(.type == "tool:start")' "$SESSION"

# Filter by correlationId (traces a single tool call end-to-end)
jq 'select(.correlationId == "CORR_ID")' "$SESSION"

# All errors
jq 'select(.bus == "debug" and (.type | test("error|failed")))' "$SESSION"
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
| `corpus action failed` | `op, correlationId, err` | typedAction handler threw |
| `cerebrum action failed` | `op, correlationId, err` | sense-side action threw |
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

Kill timer: `packages/adapter-fs/src/find-query.ts` — fires at 30s.

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
3. The ablation test: `ALEF_TEST_LLM=1 npx vitest run packages/runner/test/directive-ablation.test.ts`

## Daemon debugging

When running with `--daemon`:
- Registry: `~/.alef/daemon.json`
- Attach: `alef --attach` connects to SSE on `http://127.0.0.1:<port>/events`

```bash
cat ~/.alef/daemon.json | jq .
curl http://127.0.0.1:$(jq .port ~/.alef/daemon.json)/health
curl -N http://127.0.0.1:$(jq .port ~/.alef/daemon.json)/events
```

## Missing instrumentation (known gaps)

1. **No AbortSignal in `CorpusHandlerCtx`** — adapters cannot be cancelled mid-flight.
   Ctrl+C aborts the LLM turn but fd subprocess runs until 30s kill timer.

## Key source files

| Concern | File |
|---|---|
| `debugLog()` + `initSpineLogger()` | `packages/kernel/src/debug.ts` |
| Logger creation | `packages/runner/src/logger.ts` |
| `ctx.log` stamping | `packages/kernel/src/adapter-dispatch.ts` |
| adapter-llm events | `packages/adapter-llm/src/stream-turn.ts`, `tool-dispatch.ts`, `turn-loop.ts` |
| delegation events | `packages/adapter-delegate/src/adapter.ts`, `packages/runner/src/strategies/in-process.ts` |
| `tools:describe:miss` | `packages/runner/src/tool-shell.ts` |
| fd subprocess + kill timer | `packages/adapter-fs/src/find-query.ts` |
| Session JSONL format | `packages/session/src/session-store.ts` |
| Daemon registry + SSE | `packages/runner/src/build-delegation.ts` |

## Quick reference

```bash
# Find session JSONL
HASH=$(echo -n $(pwd) | sha1sum | cut -c1-12)
SESSION=$(ls -t ~/.alef/sessions/$HASH/*.jsonl | head -1)

# All debug events
jq 'select(.bus == "debug")' "$SESSION"

# Tool timing summary
jq 'select(.type == "tool:end") | {name: .payload.name, elapsedMs: .payload.elapsedMs, ok: .payload.ok}' "$SESSION"

# LLM call timing
jq 'select(.type == "llm:http:done" or .type == "llm:http:error")' "$SESSION"

# All delegation attempts
jq 'select(.type | test("delegate:|in-process:"))' "$SESSION"

# Context window fill per turn
jq -r 'select(.type=="window.assembled") | "\(.payload.budgetUsed)/\(.payload.budgetTotal) = \((.payload.budgetUsed/.payload.budgetTotal*100)|round)%"' "$SESSION"

# Run headless to capture everything to terminal
ALEF_LOG_LEVEL=debug alef --no-tui -p "your prompt here" 2>&1 | jq .
```

## CLI introspection (no TUI required)

```bash
alef --preflight           # Verify config, profile, model, adapters, tools, directives
alef --list-models         # Models for active profile
alef --show-config         # Parsed config.yaml
alef --list-directives     # Directive blocks with priorities
alef --list-tools          # Loaded tools
alef --list-adapters       # Loaded adapters with labels
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
