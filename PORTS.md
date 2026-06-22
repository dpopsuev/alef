# Ports — Hexagonal Architecture Reference

Alef uses a hexagonal (ports & adapters) architecture layered on an EDA
micro-kernel. The **kernel** defines port interfaces; **adapters** (currently
named `organ-*`) implement them. Ports group into four buckets by concern.

## Bus Recap

```
Motor Bus   Reasoner  ──►  Adapters     Commands (request / reply)
Sense Bus   Adapters  ──►  Reasoner     Observations (afferent)
Signal Bus  Reasoner  ──►  Observers    Telemetry (fire-and-forget)
```

## Port Buckets

### 1. Seaming — Infrastructure Ports

Declared via `contributions.port` with a `PortDefinition` (name, event
pattern, cardinality). The runtime validates cardinality at boot before the
first turn.

| Port | Event Pattern | Cardinality | Adapter | Purpose |
|---|---|---|---|---|
| `filesystem` | `motor/fs.` | zero-or-one | organ-fs | Disk I/O with path guard and truncation |
| `shell` | `motor/shell.` | zero-or-one | organ-shell | Process execution with PTY streaming |
| `enclosure` | `motor/enclosure.` | zero-or-one | organ-enclosure | Copy-on-write isolated workspaces |
| `web` | `motor/web.` | zero-or-one | organ-web | Page fetch (Readability) and web search |
| `context_assembly` | `motor/context.assemble` | ordered-pipeline | kernel built-in | Pre-LLM context assembly pipeline |

Cardinality enforcement (`kernel/port-registry.ts`):
- **exactly-one** — missing = error, duplicate = error (race condition)
- **zero-or-one** — duplicate = warning (undefined behaviour)
- **zero-or-many** — unconstrained pub-sub
- **ordered-pipeline** — multiple adapters intentional, executed in order

### 2. Reasoning — Agent Capability Ports

Declared via `contributions["agent.run"]` and `contributions.skills`.
Extend the agent's reasoning surface without coupling to the Reasoner.

| Contribution | Interface | Adapters |
|---|---|---|
| `agent.run` | `AgentRunContribution` — extend subagent schema and context | organ-agent, organ-skills |
| `skills` | `SkillBook[]` — contribute skill playbooks | organ-skills, organ-factory |

The Reasoner itself (`packages/reasoner/`) is a special `Reasoner extends
Organ` with `triggerEvent` / `replyEvent` — it drives the loop, not a port
consumer.

### 3. Pipeline — Context Assembly Ports

Declared via `contributions["context.assemble"]` and
`contributions["schema-resolver"]`. Stages run in order before each LLM call.

| Contribution | Interface | Adapters |
|---|---|---|
| `context.assemble` | `ContextAssemblyHandler` — modify messages / tools pre-turn | organ-discourse, organ-plan, organ-scribe, ToolShell |
| `schema-resolver` | `(toolName) → ToolDefinition` — resolve full tool schemas | ToolShell |

### 4. Presentation — Display Ports

Declared via `contributions.tui`, `contributions.history`, and
`contributions["signal.map"]`. Decouple adapters from any specific renderer.

| Contribution | Interface | Adapters |
|---|---|---|
| `tui` | `TuiContribution` — render tool calls / results / overlays | organ-agent, organ-enclosure, organ-eval, organ-plan, organ-workflow |
| `history` | `HistoryContribution` — per-adapter history indexing | organ-locus, organ-web |
| `signal.map` | `Record<type, mapper>` — signal-to-display event mapping | (any adapter) |

## Non-Port Adapters

These adapters expose tools on the Motor/Sense buses but do not declare port
contributions. They are pure tool providers:

| Adapter | Tools | Domain |
|---|---|---|
| organ-git | `git.*` | Repository operations |
| organ-nodesh | `nodesh.*` | Node.js REPL |
| organ-code-intel | `code-intel.*` | LSP and symbol analysis |
| organ-mcp-registry | `mcp.*` | MCP server lifecycle |
| organ-locus | `locus.*` | Architecture graph queries |

## Contribution Composition

An adapter can contribute to multiple buckets simultaneously. For example,
`organ-enclosure` declares both a **seaming** port (`motor/enclosure.`) and a
**presentation** TUI renderer. The kernel collects all contributions at mount
via `sense/organ.loaded`.

```typescript
// buses.ts — the 4 contribution interfaces compose into OrganContributions
interface OrganContributions
  extends ReasoningContributions,    // agent.run, skills
          PipelineContributions,     // context.assemble, schema-resolver
          PresentationContributions, // tui, history, signal.map
          SeamingContributions {}    // port, plan.scope
```

## Validation Flow

```
1. agent.load(adapter)     Mount, subscribe to motor/sense events
2. agent.validate()        Collect PortDefinitions, enforce cardinality
3. await agent.ready()     Async init (LSP, DB, containers)
4. agent.setReasoner(llm)  Mount Reasoner last (sees all tools)
5. dialog.send(text)       First turn begins
```

Port violations at step 2 throw `PortValidationError` with the seam name,
expected cardinality, and actual count.
