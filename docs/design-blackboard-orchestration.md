# Design: Blackboard Multi-Agent Orchestration

## Status: Proposal

## Overview

Replace the single-agent REPL with a multi-agent orchestration system centered on a blackboard (Board) for shared state. The General Secretary orchestrates, workers execute, and all communication flows through the Board.

Draws heavily from `tangle` (Troupe): ECS entity model, color-based agent identity, collective strategies, and the Broker/Actor/Director pattern.

## Core Concepts

### General Secretary

The orchestrator agent. Never executes tools directly. It:

1. Reads user intent
2. Defines a Contract (goal + agent plan + execution graph)
3. Spawns worker agents via the Broker
4. Monitors progress on the Board
5. Synthesizes results back to the user

The General Secretary is itself an agent with a color identity (reserved: `onyx` from the black shade — the coordinator).

### Board (Blackboard)

A persistent, queryable shared-state store. Backed by Dolt (Git-for-data SQL database) for versioning, branching, and diffing.

```
Board
 └── Forum (named workspace, e.g., "Project Refactor")
      └── Topic (unit of work, e.g., "Auth Module")
           └── Thread (conversation/task)
                ├── Entry (id, agent, content, timestamp, links)
                ├── Entry
                └── Thread (recursive sub-thread)
                     ├── Entry
                     └── Thread (deeper nesting)
```

Every entry has a unique ID. Entries form a linked-list graph — each has `parentId`, `prevId`, `nextId`, and typed edges to other entries (`references`, `blocks`, `supersedes`).

### Contract

Defined by the General Secretary. Specifies:

```typescript
interface Contract {
  id: string;
  goal: string;
  forumId: string;

  // Agent execution plan
  stages: ContractStage[];

  // Stop points (breakpoints)
  breakpoints: Breakpoint[];
}

interface ContractStage {
  id: string;
  name: string;
  agentRole: string;          // "scout", "worker", "reviewer"
  agentCount: number;         // 1 = serial, N = parallel
  execution: "serial" | "parallel";
  dependsOn: string[];        // stage IDs that must complete first
  topicId: string;            // where to write results on the Board
}

interface Breakpoint {
  afterStage: string;         // stage ID
  notify: "gensec" | "hitl"; // who gets the event
  condition?: string;         // optional: only break if condition met
}
```

### Agent Identity (from tangle)

Every agent gets a canonical color from the 12x12 palette (144 unique identities):

```
"Denim Worker of Indigo Refactor"
 ├── Color: Denim (#1560BD)
 ├── Role: Worker
 ├── Shade: Indigo (parent group)
 └── Collective: Refactor (the Contract/Forum)
```

User addressing: `@denim do X` or `@indigo.denim do X` for precision.

The color identity is:
- **Visual**: agent output in TUI is colored with its hex
- **Addressable**: `@colorname` routes messages in the Board
- **Unique per session**: Registry prevents collisions

### Discourse Scope

Agents can only read/write within their scope on the Board:

```
@denim (Worker) scope: forum.refactor > topic.auth > thread.implement
  - Can read: own thread + parent topic (for context)
  - Can write: own thread only
  - Cannot read: other topics or forums

@jade (Reviewer) scope: forum.refactor > topic.auth > thread.review
  - Can read: own thread + worker threads (needs to see what to review)
  - Can write: own thread only
```

Scope rules are defined in the Contract:

```typescript
interface ScopeRule {
  agentRole: string;
  read: string[];   // Board paths: ["forum.*.topic.*.thread.*"]
  write: string[];  // Board paths: ["forum.{own}.topic.{own}.thread.{own}"]
}
```

### Semantic Routing

Instead of hardcoding `@agentname`, use semantic embeddings to auto-route:

1. Each agent registers its competency profile (from its system prompt + role)
2. When a message arrives (from user or another agent), embed it
3. Cosine similarity against agent profiles determines routing
4. Threshold-based: above 0.8 = direct route, 0.5-0.8 = General Secretary decides, below 0.5 = General Secretary handles

This means `@denim fix the auth bug` routes to Denim directly, but `fix the auth bug` goes to General Secretary who decides which agent (or which new agent to spawn).

## Data Model (Dolt)

```sql
CREATE TABLE forums (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  contract_id VARCHAR(36),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE topics (
  id VARCHAR(36) PRIMARY KEY,
  forum_id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  stage_id VARCHAR(36),
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (forum_id) REFERENCES forums(id)
);

CREATE TABLE threads (
  id VARCHAR(36) PRIMARY KEY,
  topic_id VARCHAR(36) NOT NULL,
  parent_thread_id VARCHAR(36),  -- NULL for top-level, ID for sub-threads
  name VARCHAR(255),
  agent_color VARCHAR(50),       -- canonical color name
  agent_role VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (topic_id) REFERENCES topics(id),
  FOREIGN KEY (parent_thread_id) REFERENCES threads(id)
);

CREATE TABLE entries (
  id VARCHAR(36) PRIMARY KEY,
  thread_id VARCHAR(36) NOT NULL,
  agent_color VARCHAR(50) NOT NULL,
  content_type VARCHAR(20) NOT NULL,  -- 'text', 'tool_call', 'tool_result', 'decision'
  content TEXT NOT NULL,
  parent_id VARCHAR(36),       -- linked list: previous entry in thread
  created_at TIMESTAMP DEFAULT NOW(),
  metadata JSON,               -- usage stats, model info, etc.
  FOREIGN KEY (thread_id) REFERENCES threads(id),
  FOREIGN KEY (parent_id) REFERENCES entries(id)
);

CREATE TABLE edges (
  id VARCHAR(36) PRIMARY KEY,
  from_entry_id VARCHAR(36) NOT NULL,
  to_entry_id VARCHAR(36) NOT NULL,
  edge_type VARCHAR(50) NOT NULL,  -- 'references', 'blocks', 'supersedes', 'responds_to'
  FOREIGN KEY (from_entry_id) REFERENCES entries(id),
  FOREIGN KEY (to_entry_id) REFERENCES entries(id)
);

CREATE TABLE contracts (
  id VARCHAR(36) PRIMARY KEY,
  goal TEXT NOT NULL,
  forum_id VARCHAR(36) NOT NULL,
  stages JSON NOT NULL,
  breakpoints JSON,
  status VARCHAR(20) DEFAULT 'active',  -- 'active', 'paused', 'completed', 'failed'
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (forum_id) REFERENCES forums(id)
);

CREATE TABLE agent_registry (
  color VARCHAR(50) PRIMARY KEY,
  shade VARCHAR(50) NOT NULL,
  role VARCHAR(50) NOT NULL,
  collective VARCHAR(100) NOT NULL,
  hex VARCHAR(7) NOT NULL,
  contract_id VARCHAR(36),
  pid INTEGER,
  status VARCHAR(20) DEFAULT 'idle',  -- 'idle', 'running', 'stopped'
  competency_embedding BLOB,          -- for semantic routing
  created_at TIMESTAMP DEFAULT NOW()
);
```

Dolt gives us:
- `dolt diff` between contract revisions
- `dolt branch` for speculative execution
- `dolt log` for audit trail
- SQL queries across the entire board

## Execution Graph

Agents form a DAG. Each agent's output has an ID, and edges connect outputs to inputs:

```
                    ┌─────────┐
User prompt ───────►│ GenSec  │
                    │ (onyx)  │
                    └────┬────┘
                         │ Contract
                    ┌────┴────┐
                    ▼         ▼
              ┌─────────┐ ┌─────────┐
              │ Scout   │ │ Scout   │  (parallel)
              │ (jade)  │ │ (fern)  │
              └────┬────┘ └────┬────┘
                   │           │
                   └─────┬─────┘
                         │ merge
                    ┌────┴────┐
                    │ Planner │  (serial, after scouts)
                    │ (cobalt)│
                    └────┬────┘
                         │ BREAKPOINT → GenSec reviews plan
                    ┌────┴────┐
                    ▼         ▼
              ┌─────────┐ ┌─────────┐
              │ Worker  │ │ Worker  │  (parallel)
              │ (denim) │ │ (navy)  │
              └────┬────┘ └────┬────┘
                   │           │
                   └─────┬─────┘
                         │
                    ┌────┴────┐
                    │Reviewer │  (serial, after workers)
                    │ (ruby)  │
                    └────┬────┘
                         │
                    ┌────┴────┐
                    │ GenSec  │  synthesizes final answer
                    │ (onyx)  │
                    └─────────┘
```

## Integration with Existing Systems

| Existing | How It Fits |
|----------|-------------|
| **Supervisor** | Owns the GenSec process + all spawned agents via the Broker |
| **AgentBroker** | Spawns/kills/monitors worker agents on GenSec's behalf |
| **AgentTransport** | Each agent uses InProcessTransport or RpcTransport |
| **StreamingBuffer** | Each agent's output is smoothed before writing to Board |
| **Spider-Web** | Available as a tool for researcher agents |
| **Color palette** | Ported from tangle's `visual/palette.go` |

## User Interaction

```
You: Refactor the auth module to use JWT

[Onyx Secretary] Creating contract...
  Forum: "Auth Refactor"
  Stages:
    1. @jade Scout → analyze current auth (serial)
    2. @cobalt Planner → create implementation plan (serial, after scout)
       ⏸ BREAKPOINT: review plan
    3. @denim Worker + @navy Worker → implement (parallel, after plan)
    4. @ruby Reviewer → review changes (serial, after workers)

[Jade Scout] Analyzing auth module...
  → Board: forum.auth-refactor > topic.analysis > thread.jade-scout
  Found: session-based auth in 3 files, no token validation...

[Cobalt Planner] Creating implementation plan...
  → Board: forum.auth-refactor > topic.planning > thread.cobalt-planner
  Plan: 1) Add JWT library  2) Create token service  3) Replace session middleware

⏸ BREAKPOINT — @onyx reviewing plan
[Onyx Secretary] Plan looks good. Proceeding.

You: @denim also add refresh tokens
[Denim Worker] Adding refresh token support to my scope...

You: status
[Onyx Secretary] Contract "Auth Refactor"
  ✓ Stage 1: Scout (jade) — completed
  ✓ Stage 2: Planner (cobalt) — completed
  ● Stage 3: Workers (denim, navy) — running
  ○ Stage 4: Reviewer (ruby) — waiting
```

## Implementation Phases

| Phase | What | Depends On |
|-------|------|------------|
| 4a | Port color palette from tangle to TypeScript | None |
| 4b | Board data model + Dolt backend | None |
| 4c | Contract definition + execution engine | 4a, 4b |
| 4d | General Secretary agent (orchestrator prompt) | 4c |
| 4e | Discourse scope enforcement | 4b |
| 4f | Semantic routing with embeddings | 4a |
| 4g | Breakpoints and HITL integration | 4c |
| 4h | TUI integration (color-coded output, `@agent` addressing) | 4a |
