---
name: debug-alef
description: Use when debugging Alef itself — hung tools, TUI glitches, LLM loop issues, session corruption, organ failures, fs.find hangs. Use ONLY for debugging the Alef agent codebase at /home/dpopsuev/Workspace/alef, not for debugging user applications.
---

# Debugging Alef

## Log system overview

All logging is unified under pino. One file, one format, one activation knob.

**Location:** `~/.alef/debug.log` (rotates at 10 MB, 3 files kept)

**Format:** pino JSON — every line is a valid JSON object:
```json
{"level":30,"time":"2026-06-04T...","pid":12345,"component":"trace","organ":"delegate","tool":"agent.run","correlationId":"a3f9...","toolCallId":"tc-001","msg":"delegate:strategy:start","profile":"explore","timeoutMs":90000}
```

**Activation:**
- `--debug` flag — sets log level to `debug`, all events visible
- `ALEF_DEBUG=1` — identical to `--debug`
- `ALEF_LOG_LEVEL=debug` — identical to `--debug`
- No flag — only `info` and above (tool:start, tool:end, boot, tui:start, loop:detected, errors)

Always-on events fire at `info` level even without `--debug`:
`tool:start`, `tool:end`, `loop:detected`, `boot`, `tui:start`, `tui:stopped`

## Start here

```bash
# Watch live
tail -f ~/.alef/debug.log | jq .

# Filter by specific tool call (correlationId stamped on every handler log line)
jq 'select(.correlationId == "a3f9...")' ~/.alef/debug.log

# Filter by organ
jq 'select(.organ == "delegate")' ~/.alef/debug.log

# Filter by level (30=info, 20=debug, 40=warn, 50=error)
jq 'select(.level >= 40)' ~/.alef/debug.log

# See only errors with full stack traces
jq 'select(.level >= 50) | {msg, err: .err.stack}' ~/.alef/debug.log
```

## Event reference

### Lifecycle (always-on, info level)

| msg | Key fields | What it means |
|---|---|---|
| `boot` | `pid, cwd, model, tui` | Process started |
| `tui:start` | — | TUI live, accepting input |
| `tui:stopped` | — | TUI teardown complete |
| `tool:start` | `callId, name, keyArg, activeCount` | LLM dispatched a tool call |
| `tool:end` | `callId, name, elapsedMs, ok, remainingActive` | Tool result received |
| `loop:detected` | `reason` | Loop detector fired, LLM aborted |

**Hang diagnosis:** `tool:start` without matching `tool:end` = hung tool.
`callId` correlates between them.

### LLM timing (debug level, need `--debug`)

| msg | Key fields | What it means |
|---|---|---|
| `llm:phase:enter` | `turn` | llm.phase pipeline fired |
| `llm:phase:exit` | `turn, elapsedMs, modified` | pipeline resolved |
| `llm:http:start` | `turn, messages, tools` | HTTP call to provider started |
| `llm:http:done` | `turn, elapsedMs, stopReason` | stream exhausted |
| `llm:http:error` | `turn, elapsedMs, abort, err` | stream threw (err has stack) |
| `llm:retry` | `turn, attempt, reason` | retryable error, backing off |
| `llm:tool:subscribe` | `name, toolCallId` | waitForToolResult waiting on sense bus |
| `llm:tool:resolved` | `name, elapsedMs, isError` | sense event arrived |
| `llm:tool:timeout` | `name, elapsedMs` | tool timed out |
| `llm:tool:stall` | `name, elapsedMs, lastChunkMs` | no chunks for 5s |

**LLM hang:** `llm:http:start` without `llm:http:done`.
**Tool stall:** `llm:tool:stall` fires but `llm:tool:resolved` never follows.

### Delegation boundary (debug level)

| msg | Key fields | What it means |
|---|---|---|
| `delegate:strategy:start` | `organ, tool, correlationId, profile, timeoutMs` | InProcessStrategy.send() called |
| `delegate:strategy:done` | `organ, tool, correlationId, profile, elapsedMs, ok` | Strategy completed |
| `in-process:start` | `organs, timeoutMs` | Inner agent created |
| `in-process:done` | `replyLength` | Inner agent replied |
| `in-process:error` | `err` (full stack) | Inner agent threw |

### Tool catalog

| msg | Key fields | What it means |
|---|---|---|
| `tools:describe:miss` | `name, available` | LLM asked for schema of unknown tool — **warn level, no --debug needed** |

If you see `tools:describe:miss` in production logs, `name` tells you exactly which tool the LLM tried to describe but couldn't find. `available` lists what WAS in the snapshot.

### Framework errors (warn level, no --debug needed)

| msg | Key fields | What it means |
|---|---|---|
| `stream action failed` | `op, correlationId, err` | typedStreamAction generator threw |
| `corpus action failed` | `op, correlationId, err` | typedAction handler threw |
| `cerebrum action failed` | `op, correlationId, err` | sense-side action threw |
| `tool:schema-rejected` | `name, field, issues` | LLM passed invalid args |

All `err` fields are pino Error objects with `message`, `stack`, `type` — not stringified.

### fs.find events (debug level)

| msg | Key fields | What it means |
|---|---|---|
| `fs:find:spawn` | `pattern, searchPath` | fd subprocess spawned |
| `fs:find:close` | `elapsedMs, code, lines, pattern` | fd exited normally |
| `fs:find:timeout` | `elapsedMs, pattern, searchPath` | 30s kill timer fired |

## Organ handler logs (ctx.log)

Every `typedAction` and `typedStreamAction` handler receives `ctx.log` — a child logger
pre-stamped with `{ organ, tool, correlationId, toolCallId }`.

```ts
// Inside any handler:
ctx.log.warn({ path, bytes }, "file too large to read");
// Produces: { level:40, organ:"fs", tool:"fs.read", correlationId:"...", toolCallId:"...", path:"...", bytes:..., msg:"file too large to read" }
```

Filter all logs from a single tool invocation:
```bash
jq 'select(.correlationId == "CORR_ID")' ~/.alef/debug.log
```

## Diagnosing a hung fs.find

The debug log shows `tool:start` with `name: "fs.find"` and `keyArg` (the pattern).
`tool:end` is absent until the 30s kill timer fires.

Reproduce the exact fd command:
```bash
# Take pattern and cwd from keyArg in the tool:start log line
fd --glob --color=never --no-require-git --max-results 1000 --hidden -- "<pattern>" "<cwd>"
```

Kill timer: `packages/organ-fs/src/find-query.ts` — fires at 30s.
To add temporary visibility into the fd subprocess args:
```ts
// After: const child = spawn(fdPath, args, ...)
process.stderr.write(`[fd] ${fdPath} ${args.join(' ')}\n`);
```

## TUI frame capture (ALEF_DEBUG=1 only)

```bash
tail -f /tmp/alef-frames.jsonl | jq .frame
```

## Session JSONL files

Location: `~/.alef/sessions/<sha1(cwd)[0:12]>/<session-id>.jsonl`

Record schema: `{ bus: 'motor'|'sense'|'internal', type, correlationId, payload, timestamp }`

Key internal records:
- `window.assembled` — TurnAssembler output: `{ includedTurnIds, budgetUsed, budgetTotal }`
- `llm.checkpoint` — mid-turn snapshot on abort

```bash
# Find session for current cwd
HASH=$(echo -n $(pwd) | sha1sum | cut -c1-12)
SESSION=$(ls -t ~/.alef/sessions/$HASH/*.jsonl | head -1)

# Context window fill per turn
jq -r 'select(.type=="window.assembled") | "\(.payload.budgetUsed)/\(.payload.budgetTotal) = \((.payload.budgetUsed/.payload.budgetTotal*100)|round)%"' $SESSION

# All tool calls in order
jq 'select(.bus=="motor" and (.type | startswith("fs.") or startswith("shell.") or startswith("agent.")))  | {type, correlationId}' $SESSION
```

## Daemon debugging

When running with `--daemon`:
- Registry: `~/.alef/daemon.json` → `{ port, pid, sessionId, cwd, startedAt }`
- Attach: `alef --attach` connects to SSE on `http://127.0.0.1:<port>/events`
- Agent events stream as `event: agent` SSE frames with `{ kind:"agent", event: AgentEvent }`

```bash
# Check daemon is alive
cat ~/.alef/daemon.json | jq .
curl http://127.0.0.1:$(jq .port ~/.alef/daemon.json)/health

# Watch daemon SSE stream raw
curl -N http://127.0.0.1:$(jq .port ~/.alef/daemon.json)/events
```

## Missing instrumentation (known gaps)

1. **No AbortSignal in `CorpusHandlerCtx`** — organs cannot be cancelled mid-flight.
   Ctrl+C aborts the LLM turn but fd subprocess runs until 30s kill timer. (ALE-NED-1)

2. **stall watchdog fires at 5s** but only while waiting for a tool sense result.
   LLM thinking phase (HTTP call in progress) produces no chunks — stall fires correctly
   but the visual `⏳ no output for Ns` is expected, not a bug.

## Key source files

| Concern | File |
|---|---|
| `debugLog()` + `initSpineLogger()` | `packages/kernel/src/debug.ts` |
| `trace()` + `initTraceLogger()` | `packages/runner/src/debug-trace.ts` |
| Logger creation + bridge wiring | `packages/runner/src/logger.ts` |
| `ctx.log` stamping | `packages/kernel/src/organ-dispatch.ts` |
| `OrganLogger` interface | `packages/kernel/src/organ-types.ts` |
| organ-llm events | `packages/organ-llm/src/stream-turn.ts`, `tool-dispatch.ts`, `turn-loop.ts` |
| delegation events | `packages/organ-delegate/src/organ.ts`, `packages/runtime/src/in-process.ts` |
| `tools:describe:miss` | `packages/organ-toolshell/src/organ.ts` |
| fd subprocess + kill timer | `packages/organ-fs/src/find-query.ts` |
| Session JSONL format | `packages/runner/src/session-store.ts` |
| Daemon registry + SSE forwarding | `packages/runner/src/build-delegation.ts` |
| RemoteSession SSE parser | `packages/runner/src/strategies/remote-session.ts` |
| Materializer + blueprint registry | `packages/blueprint/src/materializer.ts`, `packages/blueprint/src/registry.ts` |
| Subagent factory | `packages/runner/src/subagent-factory.ts` |

## Quick reference

```bash
# All warnings and errors (no --debug needed)
jq 'select(.level >= 40)' ~/.alef/debug.log | jq '{level, organ, tool, correlationId, msg, err: .err.message}'

# Trace a specific tool call end-to-end
jq 'select(.correlationId == "CORR_ID")' ~/.alef/debug.log

# Check tool catalog miss (agent tried to describe unknown tool)
jq 'select(.msg == "tools:describe:miss")' ~/.alef/debug.log | jq '{name, available}'

# All delegation attempts
jq 'select(.msg == "delegate:strategy:start" or .msg == "delegate:strategy:done" or .msg == "in-process:error")' ~/.alef/debug.log

# Tool timing summary
jq 'select(.msg == "tool:end") | {name, elapsedMs, ok}' ~/.alef/debug.log

# LLM call timing
jq 'select(.msg == "llm:http:done" or .msg == "llm:http:error") | {msg, turn: .turn, elapsedMs, stopReason, err: .err.message}' ~/.alef/debug.log

# Run headless to capture everything to terminal
ALEF_LOG_LEVEL=debug alef --no-tui -p "your prompt here" 2>&1 | jq .
```
