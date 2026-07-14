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

### Symptom → chain break map

| Symptom | Chain break | Check with |
|---------|-------------|------------|
| TUI stuck on "thinking" | 6→7: chunks not converted | `alef log chain` |
| Nothing after send | 2→3: send didn't publish | `alef log chain` |
| Tool pill stuck active | 5→6: tool-end not emitted | `alef log events <id> --type 'llm.tool-%'` |
| Subagent reply missing | 5→6: inner events not relayed | `alef log events <id> --type 'agent.run.inner'` |
| Reply text empty | 11: response has no text | `alef log chain` |

---

## Step 2: ASSESS — Diagnose via CLI

### One-command chain analysis

```bash
alef log chain              # latest session — shows ✅/❌ per link
alef log chain <session-id> # specific session
```

This checks all 14 links and reports which fired and which didn't.

### Drill into specific areas

```bash
alef log sessions                         # list sessions (newest first)
alef log sessions --search "refactor"     # search by text
alef log events <id> --errors             # errors only
alef log events <id> --type 'llm.%'       # LLM events
alef log events <id> --type 'observer:%'  # observer bridge events
alef log events <id> --type 'tui:%'       # TUI pipeline events
alef log events <id> --adapter fs         # tool-specific events
alef log events <id> --corr <prefix>      # one correlationId
alef log trace <id> <correlationId>       # full turn trace
alef log tail --errors                    # latest session errors
```

### Causal analysis

```bash
alef log spans <id>           # list OTel spans with parent IDs
alef log cause <span-id>      # walk backwards to root cause
```

### Interactive TUI observation

```bash
alef debug tui "Hello" --reply "world"   # spawn, send, capture pane
alef debug tui --attach                  # spawn and attach interactively
```

### Tool-call pairing

```bash
alef debug session            # analyze latest session for unpaired tool calls
```

### Escape hatch

If `alef log` doesn't expose the data you need, raw sqlite3 is the escape hatch:

```bash
sqlite3 "${XDG_DATA_HOME:-$HOME/.local/share}/alef/alef.db" "YOUR QUERY"
```

**If you reach for sqlite3, it means the CLI is missing an API.** File a need in Scribe to extend `alef log` with the query you needed. The goal is zero raw SQL in debugging workflows.

### Instrumentation audit

| Chain link | Debug event | Tested? |
|-----------|-------------|---------|
| LLM HTTP | `llm:http:start/done/error` | ✅ |
| Tool dispatch | `tool:start/end` | ✅ |
| Phase pipeline | `llm:phase:enter/exit` | ✅ |
| connectObservers | `observer:convert/deliver/turn-complete` | ✅ |
| TUI observer | `tui:observer` | ✅ |
| TUI dispatch | `tui:dispatch` | ✅ |
| Delegation | `delegate:strategy:start/done` | ❌ |
| Boot | `boot` | ✅ |

---

## Step 3: INSTRUMENT — Add Observability if Missing

If the chain analysis shows ❌ at a link with no debug event, add one:

```typescript
import { traceEvent } from "@dpopsuev/alef-kernel/log";

traceEvent("my:event:start", { input });
traceEvent("my:event:done", { result, elapsedMs });
traceEvent("my:event:error", { err: String(error) });
```

After adding instrumentation, reproduce the bug again and re-run `alef log chain` to see the new events.

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
| Test suite | `test.run` tool | `@dpopsuev/alef-tool-eval` |

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

Or use the test.run tool for the LLM to run tests directly:

```
test.run({ package: "packages/core/agent/test", file: "signal-to-agent-event" })
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

### CLI debug commands

```bash
alef log sessions                    # list sessions
alef log events <id> --errors       # errors
alef log events <id> --type 'X'    # filter by type
alef log trace <id> <correlationId> # one turn
alef log spans <id>                 # OTel spans
alef log cause <span-id>            # causal chain
alef log chain                      # full round-trip diagnostic
alef log chain <id>                 # specific session
alef debug session                  # tool-call pairing
alef debug tui "prompt" --reply "r" # TUI observation
alef debug tui --attach             # interactive TUI
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
