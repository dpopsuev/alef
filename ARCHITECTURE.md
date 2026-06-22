# Alef Architecture

EDA micro-kernel AI agent with three buses and hexagonal adapter ports.

## Bus System

```
Motor Bus    Reasoner --> Adapters    Commands (RPC-like, request/reply)
Sense Bus    Adapters --> Reasoner    Observations (reply with toolCallId)
Signal Bus   Reasoner --> TUI         Telemetry (fire-and-forget, never from adapters)
```

The **Nerve** unifies all three buses into a single interface. Adapters mount once via `adapter.mount(nerve)` and subscribe to event types by prefix (`motor/fs.read`, `sense/llm.input`).

## Adapter Lifecycle

```
1. agent.load(adapter)     Mount, subscribe to motor/sense events
2. agent.validate()        Check port cardinality (exactly-one, zero-or-one)
3. await agent.ready()     Warm up (LSP servers, DB connections)
4. agent.setReasoner(llm)  Mount LLM last (sees all tools)
5. dialog.send(text)       Publish sense/llm.input, start turn loop
6. agent.dispose()         Unmount all, fire AbortController
```

## Contributions

Adapters declare capabilities without hard-wiring dependencies:

| Key | Purpose | Example |
|---|---|---|
| `context.assemble` | Pre-LLM pipeline stage | ToolShell injects tool catalog |
| `schema-resolver` | Resolve tool schemas at runtime | ToolShell returns promoted tools |
| `skills` | Contribute playbooks | adapter-skills aggregates skill books |
| `port` | Declare owned seam | adapter-discourse declares context_observer |

## Package Map

```
kernel/           Bus mechanics, defineAdapter, CacheStrategy, binding chains
runtime/          Agent class, port registry, InProcessStrategy
blueprint/        YAML schema, materializer, BlueprintRegistry
reasoner/         LLM turn loop, streaming, tool dispatch, retry
adapter-fs/       Filesystem with path guard, truncation, caching
adapter-shell/    Shell execution with platform adapters
adapter-discourse/ User/agent message boundary
adapter-agent/    Subagent dispatch (explore/general profiles)
runner/           TUI, session management, debug trace, identity
```

## Tool Dispatch Flow

```
1. LLM generates tool_use block (e.g. fs.read)
2. Reasoner publishes motor/fs.read with payload + toolCallId
3. Kernel routes to adapter-fs via motor subscription
4. adapter-dispatch validates input schema (Zod), runs async generator
5. adapter-fs yields result, kernel publishes sense/fs.read
6. Reasoner receives sense with matching toolCallId
7. Result encoded into LLM context, next turn begins
```

## Subagent Architecture

```
Parent Agent
  --> adapter-agent receives motor/agent.run
  --> InProcessStrategy creates inner Agent
  --> Inner Agent loads [domain adapters, ToolShell, pipeline, dialog, llm]
  --> dialog.send(text) triggers inner turn loop
  --> Chunks forwarded to parent via onChunk callback
  --> Reply returned as tool result
```

Profile auto-detection: prompts containing write/create/modify use `general` (full tools), others use `explore` (read-only).

## Context Assembly Pipeline

Before each LLM turn, the pipeline fires `context.assemble`:

```
1. Reasoner publishes motor/context.assemble { messages, turn, toolCount }
2. ToolShell responds with { messages: modified, tools: promotedTools }
3. Reasoner applies the result: replaces tools array, modifies messages
4. LLM API call includes the assembled tools + messages
```

Requires `phaseTimeoutMs > 0` on the LLM adapter. Without it, the pipeline is skipped.

## Binding Chains

Validation pipeline for cross-cutting concerns (security, HITL approval):

```
agent.bind({
  id: "security",
  event: "agent.run",
  chain: [{ adapter: "security-policy" }, { adapter: "hitl" }],
  mode: "ordered"   // ordered | parallel-all | parallel-first
})
```

Each stage publishes VALIDATE_REQUEST, waits for VALIDATE_RESULT. Timeout auto-approves (30s default).
