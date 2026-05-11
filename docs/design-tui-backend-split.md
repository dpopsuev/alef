# Design: TUI / Agent Backend Decoupling

## Status: Proposal

## Problem

The TUI (interactive mode) and the agent backend run in the same process. Rebuilding any core package (`@alef/ai`, `@alef/agent-core`, `@alef/coding-agent`, `@alef/tui`) requires restarting the entire process, losing the terminal session, scroll position, and visual state. `/reload` only covers extensions, skills, prompts, and themes — not core code.

## Goal

Decouple the TUI frontend from the agent backend so the backend can restart independently while the TUI survives. This enables:

- `/rebuild` that rebuilds and restarts the backend without losing the terminal
- Hot-swapping the agent backend during development
- Future: multiple backends, remote backends, or shared sessions

## Current Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Single Process                     │
│                                                      │
│  main.ts                                             │
│    ├── AgentSession (core/agent-session.ts)           │
│    │     ├── ExtensionRunner                         │
│    │     ├── ResourceLoader                          │
│    │     ├── SessionManager                          │
│    │     ├── ModelRegistry                           │
│    │     └── ToolRegistry                            │
│    │                                                 │
│    └── InteractiveMode (modes/interactive/)           │
│          ├── TUI (tui.ts) — owns the terminal        │
│          ├── AssistantMessageComponent                │
│          ├── ToolExecutionComponent                   │
│          ├── Footer, Editor, Selectors...             │
│          └── StreamingBuffer                         │
└──────────────────────────────────────────────────────┘
```

Three modes exist today:
- **Interactive** — TUI + agent in-process (tightly coupled)
- **Print** — headless, stdout, one-shot
- **RPC** — agent as a JSONL server over stdio, client spawns it as a child process

The RPC mode already implements the protocol we need. `RpcClient` in `rpc-client.ts` spawns an agent process and communicates via JSONL over stdin/stdout. The `rpc-types.ts` defines all commands and responses.

## Proposed Architecture

```
┌─────────────────────────────┐       JSONL/stdio       ┌─────────────────────────┐
│       Supervisor + TUI      │ ◄─────────────────────► │     Agent Backend       │
│       (long-lived)          │                          │     (restartable)       │
│                             │                          │                         │
│  - Owns the terminal        │                          │  - AgentSession         │
│  - TUI component tree       │                          │  - ExtensionRunner      │
│  - StreamingBuffer          │                          │  - ToolRegistry         │
│  - Render loop              │                          │  - ResourceLoader       │
│  - Input handling           │                          │  - ModelRegistry        │
│  - Theme                    │                          │  - SessionManager       │
│  - Visual state (scroll,    │                          │  - Provider streams     │
│    tool expand/collapse)    │                          │                         │
│  - Session restore on       │                          │  - Runs in RPC mode     │
│    backend restart          │                          │  - Stateless from TUI   │
│                             │                          │    perspective          │
└─────────────────────────────┘                          └─────────────────────────┘
         survives                                              can restart
         rebuilds                                              independently
```

## Design Details

### Phase 1: Supervisor Process

A new entry point (`supervisor.ts` or a flag `--supervised`) that:

1. Starts the TUI (terminal, render loop, input, theme)
2. Spawns the agent backend as a child process in RPC mode (`alef --rpc`)
3. Bridges RPC events to TUI components (the same work `interactive-mode.ts` does, but against RPC instead of in-process `AgentSession`)
4. On `/rebuild`:
   - Saves visual state (scroll position, tool expansion, editor content)
   - Runs `npm run build` (child process)
   - Kills the backend
   - Respawns the backend in RPC mode
   - Sends `get_state` / `get_messages` to restore the session
   - Rebuilds the TUI component tree from the restored messages
   - Restores visual state

### Phase 2: Refactor InteractiveMode as an RPC Client

The current `InteractiveMode` class (5500+ lines) is tightly coupled to in-process `AgentSession`. It directly calls methods like:

- `session.prompt()`
- `session.abort()`
- `session.setModel()`
- `session.getActiveToolNames()`
- `session.compact()`

And listens to events via `session.on("agentEvent", ...)`.

**Refactor goal:** Replace all direct `AgentSession` method calls with `RpcClient` method calls. The event subscription switches from in-process callbacks to JSONL event parsing.

This is the bulk of the work. `InteractiveMode` needs to become transport-agnostic — working identically whether the backend is in-process or out-of-process.

### Transport Interface

```typescript
interface AgentTransport {
  // Commands
  prompt(message: string, images?: ImageContent[]): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<Model>;
  cycleModel(): Promise<{ model: Model; thinkingLevel: ThinkingLevel } | null>;
  getState(): Promise<RpcSessionState>;
  getMessages(): Promise<AgentMessage[]>;
  compact(customInstructions?: string): Promise<CompactionResult>;
  // ... all RpcCommand types

  // Events
  onEvent(listener: (event: AgentEvent) => void): () => void;

  // Lifecycle
  restart(): Promise<void>;
  stop(): Promise<void>;
}
```

Two implementations:
- **`InProcessTransport`** — wraps `AgentSession` directly (current behavior, zero overhead)
- **`RpcTransport`** — wraps `RpcClient` (child process via JSONL)

### Phase 3: Hot Rebuild

With the transport abstraction in place, `/rebuild` becomes:

```typescript
pi.registerCommand("rebuild", {
  handler: async (_args, ctx) => {
    // 1. Save state
    const state = await transport.getState();
    const editorText = editor.getText();
    const scrollPos = viewport.getScrollPosition();

    // 2. Build
    const result = await exec("npm", ["run", "build"], { cwd: REPO_ROOT });
    if (result.code !== 0) { /* show error */ return; }

    // 3. Restart backend
    await transport.restart();

    // 4. Restore
    // Backend reloads session from disk (SessionManager persists to JSONL)
    // TUI rebuilds component tree from get_messages()
    const messages = await transport.getMessages();
    rebuildChatFromMessages(messages);
    editor.setText(editorText);
    viewport.setScrollPosition(scrollPos);
  },
});
```

## What Already Exists

| Piece | Status | Location |
|-------|--------|----------|
| RPC protocol (commands + responses) | Complete | `rpc-types.ts` |
| RPC server (agent side) | Complete | `rpc-mode.ts` |
| RPC client (spawns + communicates) | Complete | `rpc-client.ts` |
| JSONL serialization | Complete | `jsonl.ts` |
| Extension UI over RPC | Complete | `RpcExtensionUIRequest/Response` |
| Session persistence (JSONL files) | Complete | `session-manager.ts` |
| Message replay from session | Complete | `renderInitialMessages()` in interactive-mode |
| Event types | Complete | `@alef/agent-core` AgentEvent |

## What Needs to Be Built

| Piece | Effort | Description |
|-------|--------|-------------|
| `AgentTransport` interface | Small | Abstract the command/event boundary |
| `InProcessTransport` | Small | Wraps existing `AgentSession` — mechanical extraction |
| `RpcTransport` | Small | Wraps existing `RpcClient` — mostly done |
| Refactor `InteractiveMode` | Large | Replace ~50 direct `session.*` calls with `transport.*`. This is the critical path. |
| Supervisor entry point | Medium | New mode that spawns backend + owns TUI |
| State save/restore | Medium | Serialize visual state, replay on reconnect |
| `/rebuild` command (core) | Small | Kill backend, build, respawn, restore |
| Extension UI bridging | Small | Already implemented in RPC mode |

## Risks and Considerations

### Latency

In-process method calls are ~0ns. RPC via stdio JSONL adds ~0.1-0.5ms per message. For token streaming at 60 tokens/second, that's 60 JSONL messages/second — trivial overhead. The `StreamingTextBuffer` already absorbs any jitter.

### Extension UI

Extensions that use `ctx.ui.select()`, `ctx.ui.confirm()`, etc. already work over RPC via the `RpcExtensionUIRequest/Response` protocol. No changes needed.

### Extension Tools

Custom tools registered by extensions run in the backend process. The TUI only sees their results via events. No changes needed.

### Session State

Sessions are persisted as JSONL files by `SessionManager`. On backend restart, the backend reloads from the same session file. The TUI replays messages via `get_messages`. This is the same flow as `/resume` today.

### Breaking Changes

None for users. The `InProcessTransport` preserves exact current behavior. The supervisor mode would be opt-in (`alef --supervised` or a setting).

## Migration Path

1. **Extract `AgentTransport` interface** from the ~50 `session.*` call sites in `InteractiveMode`
2. **Create `InProcessTransport`** wrapping `AgentSession` — verify all tests pass, behavior identical
3. **Create `RpcTransport`** wrapping `RpcClient`
4. **Add supervisor mode** behind a flag
5. **Implement `/rebuild`** in supervised mode
6. **Optional:** Make supervised mode the default for development

## Non-Goals (for now)

- Remote backends (TCP/WebSocket transport) — future, same interface
- Multiple simultaneous backends — future
- TUI hot-reload (rebuilding `@alef/tui` itself) — would require restarting the supervisor too
- Web UI as a frontend — already exists as `@alef/web-ui`, could share `AgentTransport`
