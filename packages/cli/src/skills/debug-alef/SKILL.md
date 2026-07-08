---
name: debug-alef
description: Diagnose Alef issues via data flow tracing, instrumentation audit, and test coverage gaps. Use when the TUI doesn't render, tools hang, events vanish, or behavior diverges from expectation.
---

# Debugging Alef

## Step 1: Build the Round-Trip Event Chain

Every user interaction follows a data flow chain. Trace it end-to-end before looking at code.

### Message round-trip (user types → reply renders)

```
 1. editor.onSubmit         (client/submit.ts)
 2. session.send()          (boot/handle.ts → AgentController)
 3. bus event/llm.input     (agent publishes to event bus)
 4. Reasoner subscribes     (reasoner/turn-loop.ts)
 5. HTTP stream to LLM      (ai/providers → stream-turn.ts)
 6. Chunks stream back      (bus notification/llm.chunk for each)
 7. connectObservers        (core/agent/assemble.ts: bus → AgentEvent)
 8. session.subscribe       (TUI dispatch receives AgentEvent)
 9. dispatchTuiEvent        (client/events.ts → state update)
10. tui.requestRender       (TUI repaints terminal)
11. bus command/llm.response (stream ends, reply published)
12. AgentController resolves pending promise
```

### Tool call round-trip

```
 1. LLM emits tool_use      (stream-turn.ts parses tool block)
 2. bus notification/llm.tool-start
 3. dispatchTools            (reasoner/tool-dispatch.ts)
 4. bus command/{tool.name}  (adapter handler executes)
 5. bus event/{tool.name}    (result published)
 6. bus notification/llm.tool-end
 7. Tool result fed back to LLM
```

### Subagent round-trip

```
 1. LLM calls agent.run     (tools/agent/adapter.ts)
 2. InProcessStrategy.send   (engine/in-process.ts)
 3. SubagentFactory          (core/agent/subagent-factory.ts)
 4. Inner agent loop         (own bus, own reasoner)
 5. Inner chunks relay       (notification/agent.run.inner)
 6. connectObservers maps    (inner-tool-start, inner-chunk, etc.)
 7. Outer LLM receives toolResult
```

## Step 2: Trace the Actual Session

```bash
# Find the session
sqlite3 ~/.alef/alef.db "SELECT session_id, type, SUBSTR(json_extract(payload,'$.text'),1,80) FROM events WHERE type='llm.input' ORDER BY timestamp DESC LIMIT 5"

# Full event trace (skip adapter.loaded noise)
sqlite3 ~/.alef/alef.db "SELECT bus, type, SUBSTR(json_extract(payload,'$.text'),1,80) FROM events WHERE session_id='SESSION_ID' AND type NOT LIKE 'adapter%' ORDER BY timestamp"

# Errors only
sqlite3 ~/.alef/alef.db "SELECT bus, type, json_extract(payload,'$.err') FROM events WHERE session_id='SESSION_ID' AND (type LIKE '%error%' OR type LIKE '%fail%') ORDER BY timestamp"

# Tool-call pairing (start without end = hung)
sqlite3 ~/.alef/alef.db "SELECT type, json_extract(payload,'$.callId') as cid, json_extract(payload,'$.name') as name FROM events WHERE session_id='SESSION_ID' AND type IN ('llm.tool-start','llm.tool-end') ORDER BY timestamp"
```

## Step 3: Match Chain Link to Failure Point

| Symptom | Chain break | Check |
|---------|-------------|-------|
| TUI shows "thinking" forever | Link 6→7: chunks not converted | Check `signalToAgentEvent` switch for the event type |
| TUI shows nothing after send | Link 2→3: session.send didn't publish | Check `llm.input` in session events |
| Tool pill stuck as active | Link 5→6: tool-end not emitted | Check `llm.tool-end` in session events |
| Subagent reply missing | Link 5→6: inner events not relayed | Check `agent.run.inner` notifications |
| Reply text empty | Link 11: llm.response has no text | Check provider response parsing |

## Step 4: Assess Instrumentation

For each chain link, verify:
1. **Is the event published?** — check session JSONL/sqlite
2. **Is it on the right bus?** — command vs event vs notification
3. **Is there a debug event?** — `traceEvent()` call at the site
4. **Is there an OTel span?** — `alef log spans <id>`

### Instrumented (has traceEvent or OTel span)

| Chain link | Debug event | OTel span |
|-----------|-------------|-----------|
| LLM HTTP call | `llm:http:start/done/error` | `chat {model}` |
| Tool dispatch | `tool:start/end` | `alef.command/{type}` |
| Phase pipeline | `llm:phase:enter/exit` | — |
| Tool stall | `llm:tool:stall` | — |
| Delegation | `delegate:strategy:start/done` | — |
| Boot | `boot` | — |
| TUI lifecycle | `tui:start/stopped` | — |

### NOT instrumented (gaps)

| Chain link | What's missing |
|-----------|----------------|
| `connectObservers` | No trace when bus event → AgentEvent conversion happens or fails |
| `dispatchTuiEvent` | No trace when AgentEvent → TUI state update happens |
| `session.subscribe` | No trace when observer is notified |
| `tui.requestRender` | No trace when render is requested vs actually painted |

## Step 5: Assess Test Coverage

For each chain link, check:

```bash
# Does a test exercise this function?
grep -rn "FUNCTION_NAME" packages/cli/test/ packages/core/*/test/ --include="*.ts" | grep -v node_modules
```

### Coverage map

| Chain link | Function | Tested? |
|-----------|----------|---------|
| 1. Submit | `createSubmitHandler` | ✅ colon-command-submit, concurrent-prompts |
| 2. Send | `session.send` | ✅ interactive, local-session-observer |
| 3. Bus publish | `llm.input` | ✅ engine/walking-skeleton |
| 4. Reasoner | `createAgentLoop` | ✅ reasoner/e2e, llm-adapter |
| 5. HTTP stream | provider stream | ✅ ai/stream, abort |
| 6. Chunks | `llm.chunk` | ✅ contract-scan |
| 7. Observer bridge | `signalToAgentEvent` | ❌ ZERO TESTS |
| 8. TUI dispatch | `dispatchTuiEvent` | ✅ tui-dispatch |
| 9. Render | `requestRender` | ✅ tui-render |
| 10. Response | `llm.response` | ✅ lifecycle |

## Step 6: Debug Tooling Reference

### Session query (sqlite)
```bash
sqlite3 ~/.alef/alef.db "SELECT ..." 
```

### CLI tools
```bash
alef log sessions                    # list sessions
alef log events <id> --errors       # errors in session
alef log trace <id> <correlationId> # one turn
alef log spans <id>                 # OTel spans
alef log cause <span-id>            # causal chain
alef debug session                  # tool-call pairing
```

### TUI frame capture
```bash
ALEF_DEBUG=1 alef  # writes /tmp/alef-frames.jsonl
tail -f /tmp/alef-frames.jsonl | jq .frame
```

### Headless capture
```bash
ALEF_DEBUG=1 alef --no-tui -p "prompt" 2>&1
```

### tmux observation (spawn Alef and watch)
```bash
# Spawn Alef in a tmux session
tmux new-session -d -s alef-watch -x 120 -y 30 \
  "ALEF_SCRIPTED_REPLIES='[\"test reply\"]' npx tsx packages/cli/src/entrypoint.ts"

# Wait for TUI to start
sleep 3

# Capture what the TUI shows
tmux capture-pane -t alef-watch -p

# Send keystrokes
tmux send-keys -t alef-watch "Hello" Enter

# Capture after interaction
sleep 2
tmux capture-pane -t alef-watch -p

# Cleanup
tmux kill-session -t alef-watch
```

### node-pty observation (programmatic)
```typescript
import { spawn } from "node-pty";
const pty = spawn(process.execPath, [tsx, main], {
  name: "xterm-256color", cols: 120, rows: 30, cwd,
  env: { ...process.env, ALEF_SCRIPTED_REPLIES: JSON.stringify(["reply"]), ALEF_DEBUG: "1" },
});
pty.onData((data) => output += data);
// Wait for [ALEF_READY], then send keystrokes
```
