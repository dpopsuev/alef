---
name: reproduce
description: Reproduce a bug as a failing test, then fix it (TDD). Covers instrumentation, test writing, and the red→green cycle. Use when a bug report or unexpected behavior needs a regression test before fixing.
---

# Reproduce → Test → Fix (TDD for Alef bugs)

## The Cycle

```
1. TRACE    — build the event chain, find where data flow breaks
2. ASSESS   — is there enough instrumentation to observe the break?
3. INSTRUMENT — if not, add traceEvent/bus events at the gap
4. REPRODUCE — write a failing test that captures the broken behavior
5. FIX      — make the test green
6. VERIFY   — run the full suite, commit
```

## Step 1: TRACE — Load the Debug Skill

Use the `debug-alef` skill to build the round-trip event chain and locate the break point. The output is a chain like:

```
1. editor.onSubmit    ✅
2. session.send       ✅
3. bus/llm.input      ✅
4. Reasoner           ✅
5. HTTP stream        ✅
6. Chunks stream      ✅
7. connectObservers   ❌ ← BREAK
8. session.subscribe  (never reached)
```

## Step 2: ASSESS — Is the Break Point Observable?

For each break point, check:

| Question | How to check | If NO |
|----------|-------------|-------|
| Is there a session event at this point? | `sqlite3 ~/.alef/alef.db "SELECT ... WHERE type='EVENT_TYPE'"` | Add `traceEvent()` |
| Is there a test that exercises this function? | `grep -rn "FUNCTION" packages/*/test/` | Write one |
| Can you reproduce without a real LLM? | Check if `ScriptedReasoner` or `ALEF_SCRIPTED_REPLIES` covers the scenario | Add a `step.*()` script |
| Can you observe the TUI rendering? | `ALEF_DEBUG=1` frame capture or `node-pty` test | Use PTY harness |

## Step 3: INSTRUMENT — Add Observability

If the break point has no event, add one:

```typescript
// In the function where the break occurs
import { traceEvent } from "@dpopsuev/alef-kernel/log";

// Before the operation
traceEvent("my:event:start", { input: data });

// After the operation (or in catch)
traceEvent("my:event:done", { result, elapsedMs });
traceEvent("my:event:error", { err: String(error) });
```

For bus events, publish to the notification bus:
```typescript
bus.notification.publish({
  type: "my.custom.event",
  payload: { detail: value },
  correlationId: event.correlationId,
});
```

## Step 4: REPRODUCE — Write the Failing Test

### Choose the right test harness

| Scenario | Harness | Example |
|----------|---------|---------|
| Bus event conversion | Direct function call | `signalToAgentEvent(event)` |
| Agent round-trip | `ScriptedReasoner` + `Agent` | `packages/cli/test/lifecycle.test.ts` |
| Remote attach | `createRemoteHarness` | `packages/cli/test/remote-attach.test.ts` |
| TUI rendering | `node-pty` + `ALEF_SCRIPTED_REPLIES` | `packages/cli/test/smoke-tui.test.ts` |
| TUI state | Mock `TuiUi` + `dispatchTuiEvent` | `packages/cli/test/tui-dispatch.test.ts` |
| Tool execution | `AdapterHarness` | `packages/core/testkit` |
| Full E2E with real LLM | `createE2eSession` | `packages/core/testkit/src/e2e-session.ts` |

### Test template (RED)

```typescript
import { describe, expect, it } from "vitest";

describe("BUG_DESCRIPTION", { tags: ["unit"] }, () => {
  it("EXPECTED_BEHAVIOR", async () => {
    // Arrange — set up the minimum reproduction
    
    // Act — trigger the behavior
    
    // Assert — verify the expected outcome
    expect(result).toBe(expected); // THIS SHOULD FAIL (RED)
  });
});
```

### Scripted LLM patterns

```typescript
import { step } from "@dpopsuev/alef-testkit/script";

// Simple reply
step.reply("Hello from agent")

// Tool call + reply
step.toolCall("fs.read", { path: "src/main.ts" }, "I read the file.")

// Parallel tool calls + reply
step.toolCalls([
  { name: "fs.read", args: { path: "a.ts" } },
  { name: "fs.read", args: { path: "b.ts" } },
], "I read both files.")
```

### TUI observation via tmux

```bash
# Spawn Alef with scripted replies in tmux
tmux new-session -d -s repro -x 120 -y 30 \
  "ALEF_SCRIPTED_REPLIES='[\"reply\"]' ALEF_DEBUG=1 npx tsx packages/cli/src/entrypoint.ts"

# Wait for [ALEF_READY]
for i in $(seq 1 20); do
  tmux capture-pane -t repro -p | grep -q "ALEF_READY" && break
  sleep 0.5
done

# Send input
tmux send-keys -t repro "Hello" Enter

# Wait and capture
sleep 2
tmux capture-pane -t repro -p > /tmp/tui-capture.txt
cat /tmp/tui-capture.txt

# Cleanup
tmux send-keys -t repro C-c
tmux kill-session -t repro
```

### TUI observation via node-pty (in test)

```typescript
import { spawn } from "node-pty";

const pty = spawn(process.execPath, [tsx, main], {
  name: "xterm-256color",
  cols: 120,
  rows: 30,
  cwd,
  env: {
    ...process.env,
    ALEF_SCRIPTED_REPLIES: JSON.stringify(["test reply"]),
    ALEF_DEBUG: "1",
  },
});

let output = "";
pty.onData((data) => { output += data; });

// Wait for TUI ready
await waitFor(() => output.includes("[ALEF_READY]"));

// Send message
pty.write("Hello\r");

// Wait for reply to render
await waitFor(() => output.includes("test reply"));

// Assert
expect(output).toContain("test reply");

pty.kill();
```

## Step 5: FIX — Make It Green

Fix the code, run the test, confirm GREEN:

```bash
npx vitest run packages/path/to/test.test.ts
```

## Step 6: VERIFY — Full Suite

```bash
npx tsc --noEmit                    # type-check
npx vitest run packages/cli/test    # CLI tests
npm run check:lint                  # ESLint (zero warnings)
```

## Commit Convention

```
fix(PACKAGE): DESCRIPTION

Root cause: WHERE_THE_BUG_WAS
Test: TEST_FILE_NAME — WHAT_IT_VERIFIES

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

## Quick Reference: Test Harnesses

| Import | From | Purpose |
|--------|------|---------|
| `ScriptedReasoner` | `@dpopsuev/alef-testkit/scripted-reasoner` | Deterministic LLM |
| `step` | `@dpopsuev/alef-testkit/script` | Build script steps |
| `AdapterHarness` | `@dpopsuev/alef-testkit/adapter-harness` | Test single adapter |
| `BusFixture` | `@dpopsuev/alef-testkit/bus-fixture` | Isolated bus |
| `InMemorySessionStore` | `@dpopsuev/alef-testkit/memory-store` | In-memory sessions |
| `createInMemoryStorage` | `@dpopsuev/alef-testkit/memory-storage` | Full storage stub |
| `createRemoteHarness` | `@dpopsuev/alef-testkit/remote-harness` | HTTP/SSE test server |
| `TurnDriver` | `@dpopsuev/alef-testkit` | Drive agent turns |
| `Agent` | `@dpopsuev/alef-engine/agent` | Agent instance |
| `AgentController` | `@dpopsuev/alef-engine/controller` | Send/receive |
| `InProcessBus` | `@dpopsuev/alef-kernel/bus` | Bus instance |
