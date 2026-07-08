---
name: debug-alef
description: Diagnose, reproduce, and fix Alef bugs via data flow tracing, test-first development. Use when TUI doesn't render, tools hang, events vanish, tests fail, or behavior diverges from expectation. Triggers on "debug", "RCA", "reproduce", "why doesn't", "hung", "stuck", "broken".
---

# Debug Alef — Trace → Reproduce → Fix

One pipeline, six steps:

```
1. TRACE      — build the event chain, find where data flow breaks
2. ASSESS     — is there instrumentation to observe the break?
3. INSTRUMENT — if not, add traceEvent/bus events at the gap
4. REPRODUCE  — write a failing test (RED)
5. FIX        — make the test pass (GREEN)
6. VERIFY     — full suite, commit
```

---

## Step 1: TRACE — Build the Round-Trip Event Chain

Every user interaction follows a chain. Trace it before looking at code.

### Message round-trip

```
 1. editor.onSubmit         (client/submit.ts)           → user hits Enter
 2. session.send()          (boot/handle.ts)              → SessionHandle → AgentController
 3. bus event/llm.input     (agent publishes)             → message on event bus
 4. Reasoner subscribes     (reasoner/turn-loop.ts)       → picks up llm.input
 5. HTTP stream to LLM      (ai/providers → stream-turn)  → HTTP call
 6. Chunks stream back      (notification/llm.chunk)      → each token
 7. connectObservers        (core/agent/assemble.ts)      → bus event → AgentEvent
 8. session.subscribe       (TUI dispatch)                → observers notified
 9. dispatchTuiEvent        (client/events.ts)            → state update
10. tui.requestRender       (TUI repaints)                → terminal output
11. bus command/llm.response (stream done)                → reply published
```

### Tool call round-trip

```
 1. LLM emits tool_use      → stream-turn parses tool block
 2. notification/llm.tool-start
 3. dispatchTools            → reasoner/tool-dispatch.ts
 4. command/{tool.name}      → adapter handler executes
 5. event/{tool.name}        → result published
 6. notification/llm.tool-end
 7. Result fed back to LLM
```

### Subagent round-trip

```
 1. LLM calls agent.run     → tools/agent/adapter.ts
 2. InProcessStrategy.send   → engine/in-process.ts
 3. SubagentFactory          → core/agent/subagent-factory.ts
 4. Inner agent loop         → own bus, own reasoner
 5. Inner chunks relay       → notification/agent.run.inner
 6. connectObservers maps    → inner-tool-start, inner-chunk
 7. Outer LLM receives toolResult
```

### Symptom → chain break map

| Symptom | Chain break | Check |
|---------|-------------|-------|
| TUI stuck on "thinking" | 6→7: chunks not converted | `signalToAgentEvent` switch |
| Nothing after send | 2→3: send didn't publish | `llm.input` in events |
| Tool pill stuck active | 5→6: tool-end not emitted | `llm.tool-end` in events |
| Subagent reply missing | 5→6: inner events not relayed | `agent.run.inner` notifications |
| Reply text empty | 11: response has no text | Provider response parsing |

---

## Step 2: ASSESS — Trace the Actual Session

```bash
# Find the session
sqlite3 ~/.alef/alef.db \
  "SELECT session_id, type, SUBSTR(json_extract(payload,'$.text'),1,80)
   FROM events WHERE type='llm.input' ORDER BY timestamp DESC LIMIT 5"

# Full event trace (skip adapter.loaded)
sqlite3 ~/.alef/alef.db \
  "SELECT bus, type, SUBSTR(json_extract(payload,'$.text'),1,80)
   FROM events WHERE session_id='ID' AND type NOT LIKE 'adapter%'
   ORDER BY timestamp"

# Errors only
sqlite3 ~/.alef/alef.db \
  "SELECT bus, type, json_extract(payload,'$.err')
   FROM events WHERE session_id='ID' AND type LIKE '%error%'
   ORDER BY timestamp"

# Tool-call pairing (start without end = hung)
sqlite3 ~/.alef/alef.db \
  "SELECT type, json_extract(payload,'$.callId'), json_extract(payload,'$.name')
   FROM events WHERE session_id='ID'
   AND type IN ('llm.tool-start','llm.tool-end') ORDER BY timestamp"
```

### Instrumentation audit

| Chain link | Debug event | OTel span | Tested? |
|-----------|-------------|-----------|---------|
| LLM HTTP | `llm:http:start/done` | `chat {model}` | ✅ |
| Tool dispatch | `tool:start/end` | `alef.command/{type}` | ✅ |
| Phase pipeline | `llm:phase:enter/exit` | — | ✅ |
| connectObservers | — | — | ❌ |
| dispatchTuiEvent | — | — | ✅ |
| Delegation | `delegate:strategy:start/done` | — | ❌ |
| Boot | `boot` | — | ✅ |

---

## Step 3: INSTRUMENT — Add Observability if Missing

```typescript
import { traceEvent } from "@dpopsuev/alef-kernel/log";

traceEvent("my:event:start", { input });
traceEvent("my:event:done", { result, elapsedMs });
traceEvent("my:event:error", { err: String(error) });
```

---

## Step 4: REPRODUCE — Write the Failing Test

### Pick the right harness

| Scenario | Harness | Import |
|----------|---------|--------|
| Bus event conversion | Direct call | `signalToAgentEvent(event)` |
| Agent round-trip | `ScriptedReasoner` + `Agent` | `@dpopsuev/alef-testkit` |
| Remote attach | `createRemoteHarness` | `@dpopsuev/alef-testkit/remote-harness` |
| TUI rendering | `createTuiHarness` | `@dpopsuev/alef-testkit/tui-harness` |
| TUI state | `dispatchTuiEvent` | `client/events.ts` |
| Tool execution | `AdapterHarness` | `@dpopsuev/alef-testkit/adapter-harness` |
| Full E2E | `createE2eSession` | `@dpopsuev/alef-testkit/e2e` |

### Scripted LLM patterns

```typescript
import { step } from "@dpopsuev/alef-testkit/script";

step.reply("Hello")
step.toolCall("fs.read", { path: "a.ts" }, "Done.")
step.toolCalls([
  { name: "fs.read", args: { path: "a.ts" } },
  { name: "fs.read", args: { path: "b.ts" } },
], "Read both.")
```

### TUI observation via TuiHarness

```typescript
import { createTuiHarness } from "@dpopsuev/alef-testkit/tui-harness";

const tui = await createTuiHarness({ cwd, replies: ["test reply"] });
tui.type("Hello");
await tui.waitFor(/test reply/);
expect(tui.output()).toContain("test reply");
tui.kill();
```

### TUI observation via tmux (interactive debugging)

```bash
tmux new-session -d -s repro -x 120 -y 30 \
  "ALEF_SCRIPTED_REPLIES='[\"reply\"]' ALEF_DEBUG=1 npx tsx packages/cli/src/entrypoint.ts"
sleep 3
tmux capture-pane -t repro -p
tmux send-keys -t repro "Hello" Enter
sleep 2
tmux capture-pane -t repro -p
tmux kill-session -t repro
```

### Test template (RED)

```typescript
describe("BUG_DESCRIPTION", { tags: ["unit"] }, () => {
  it("EXPECTED_BEHAVIOR", async () => {
    // Arrange — minimum reproduction
    // Act — trigger
    // Assert — should FAIL (RED)
    expect(result).toBe(expected);
  });
});
```

---

## Step 5: FIX — Make It Green

Fix the code, run the test:

```bash
npx vitest run packages/path/to/test.test.ts
```

---

## Step 6: VERIFY — Full Suite

```bash
npx tsc --noEmit
npx vitest run packages/cli/test
npm run check:lint
```

### Commit convention

```
fix(PACKAGE): DESCRIPTION

Root cause: WHERE
Test: FILE — WHAT_IT_VERIFIES
```

---

## Quick Reference

### CLI tools

```bash
alef log sessions                    # list sessions
alef log events <id> --errors       # errors
alef log trace <id> <correlationId> # one turn
alef log spans <id>                 # OTel spans
alef log cause <span-id>            # causal chain
alef debug session                  # tool-call pairing
```

### Env vars

```bash
ALEF_DEBUG=1          # debug events + [ALEF_READY] marker + frame capture
NO_COLOR=1            # strip ANSI for pattern matching
ALEF_SCRIPTED_REPLIES # JSON array of canned LLM replies
```

### Testkit imports

| Import | From |
|--------|------|
| `ScriptedReasoner` | `@dpopsuev/alef-testkit/scripted-reasoner` |
| `step` | `@dpopsuev/alef-testkit/script` |
| `createRemoteHarness` | `@dpopsuev/alef-testkit/remote-harness` |
| `createTuiHarness` | `@dpopsuev/alef-testkit/tui-harness` |
| `createInMemoryStorage` | `@dpopsuev/alef-testkit/memory-storage` |
| `AdapterHarness` | `@dpopsuev/alef-testkit/adapter-harness` |
| `BusFixture` | `@dpopsuev/alef-testkit/bus-fixture` |
| `TurnDriver` | `@dpopsuev/alef-testkit` |
| `InMemorySessionStore` | `@dpopsuev/alef-testkit/memory-store` |
