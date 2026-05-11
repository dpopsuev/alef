# Design: Memory System — Dual-Model Context Management

## Status: Proposal

## Problem

Current Alef context management is linear — messages accumulate until compaction summarizes and discards. No persistent recall, no semantic linking, no structured memory beyond the JSONL session file. Knowledge evaporates between sessions.

## Goal

A three-tier memory system with a dual-model architecture:

1. **Working Model** (Model A) — the user-facing agent. Performs work, calls tools, responds to prompts. Sees a lean, focused context window.
2. **Memory Model** (Model B) — the librarian. Listens to all I/O, creates semantic links, manages the knowledge graph. Runs in the background, never user-facing.

## Architecture

```
User prompt
     │
     ▼
┌─────────────────────────────────────────┐
│ Working Model (A) — user-facing         │
│                                         │
│ Context window:                         │
│   - System prompt                       │
│   - Working memory (recent turns)       │
│   - Recalled memories (injected by B)   │
│   - Tool results                        │
└────────┬───────────────┬────────────────┘
         │ output        │ tool calls
         ▼               ▼
    ┌─────────┐    ┌──────────┐
    │ Board   │    │ Tools    │
    │ (entry) │    │          │
    └────┬────┘    └──────────┘
         │
         ▼ all I/O streamed to B
┌─────────────────────────────────────────┐
│ Memory Model (B) — background librarian │
│                                         │
│ Responsibilities:                       │
│   1. Extract entities + relations       │
│   2. Create embeddings                  │
│   3. Link entries on the Board          │
│   4. Maintain the knowledge graph       │
│   5. Compaction (moving window)         │
│   6. Recall: select memories for A      │
│                                         │
│ Storage:                                │
│   - Dolt (versioned SQL)                │
│   - Embeddings (vector column)          │
│   - Graph edges (typed relations)       │
└─────────────────────────────────────────┘
```

## Three Memory Tiers (from Zylos research + Letta/MemGPT)

| Tier | What | Lifetime | Size | Access |
|------|------|----------|------|--------|
| **Working** | Current turns, active tool calls | Session | ~4K tokens | Always in context |
| **Episodic** | Past interactions, timestamped | Cross-session | Unbounded | Retrieved by B |
| **Semantic** | Facts, entities, relations | Permanent | Unbounded | Graph queries by B |

### Working Memory (in-context)
The moving window. Model A always sees:
- System prompt
- Last N turns (configurable, default 20)
- Any recalled memories injected by Model B
- Active tool call/result pairs

### Episodic Memory (Dolt)
Every input/output is stored as a Board entry with:
- Timestamp
- Agent color (who said it)
- Content type (text, tool_call, tool_result, decision)
- Embedding vector (computed by B)
- Parent/child links (thread structure)

### Semantic Memory (knowledge graph)
Model B extracts:
- **Entities**: files, functions, concepts, people, decisions
- **Relations**: `modifies`, `depends_on`, `decided_by`, `replaced_by`
- **Properties**: timestamps, confidence scores, source entry IDs

Stored as edges in the Board's graph model + Dolt tables.

## Compaction: Moving Window with Tree Index

Inspired by Scribe/Parchment's artifact graph and the "observational memory" pattern:

```
Turn 1  ──┐
Turn 2    │ Window 1 (oldest)
Turn 3  ──┘     │
                 ▼ Compact → Observation node
Turn 4  ──┐          │
Turn 5    │ Window 2  │  Tree index
Turn 6  ──┘     │     │  preserves
                 ▼     │  references
Turn 7  ──┐           │
Turn 8    │ Window 3   │
Turn 9  ──┘     │     │
                 ▼     ▼
              ┌─────────────┐
              │ Knowledge   │
              │ Graph       │
              │ (permanent) │
              └─────────────┘
```

**Moving window compaction:**
1. Window size: N turns (default: 10)
2. When window fills: Model B summarizes → creates an **Observation** entry
3. Observation is timestamped, linked to source entries
4. Source entries move to episodic storage (Dolt), out of working memory
5. Observation stays in a **tree index** — a compact hierarchy:
   - Session observations (per 10 turns)
   - Day observations (per session)
   - Project observations (per day)

**Tree index for recall:**
```
Project: "Auth Refactor"
  ├── Day 2026-05-11
  │     ├── Session 1: "Analyzed auth module, found 3 issues"
  │     ├── Session 2: "Implemented JWT, worker agents helped"
  │     └── Session 3: "Reviewer found edge case in refresh"
  └── Day 2026-05-12
        └── Session 1: "Fixed refresh token, all tests pass"
```

Model B maintains this tree. When Model A needs context for a new task, B walks the tree and injects relevant observations.

## Recall: How B Feeds A

When the user sends a prompt:

1. Model B embeds the prompt
2. Cosine similarity search against episodic entries (vector)
3. Graph walk from matching entities (knowledge graph)
4. Rank by relevance + recency
5. Inject top-K memories into Model A's context as `[Memory]` blocks

```
System prompt: ...

[Memory] 2026-05-11: User prefers TypeScript over Python for backend.
[Memory] 2026-05-11: Auth module uses session-based auth, no JWT.
[Memory] 2026-05-10: Project has 85% test coverage target.

User: Add JWT authentication to the API```

## Dolt Integration

Dolt = Git for data. SQL interface + branch/diff/merge.

### Schema

```sql
-- Episodic memory: every I/O event
CREATE TABLE episodes (
  id VARCHAR(36) PRIMARY KEY,
  session_id VARCHAR(36) NOT NULL,
  thread_id VARCHAR(36),
  agent_color VARCHAR(50),
  role VARCHAR(20) NOT NULL,        -- 'user', 'assistant', 'tool', 'system'
  content_type VARCHAR(20) NOT NULL, -- 'text', 'tool_call', 'tool_result'
  content TEXT NOT NULL,
  embedding BLOB,                    -- float32 vector
  turn_index INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  compacted BOOLEAN DEFAULT FALSE,
  observation_id VARCHAR(36)         -- links to observation that compacted this
);

-- Observations: compacted summaries (the tree index)
CREATE TABLE observations (
  id VARCHAR(36) PRIMARY KEY,
  parent_id VARCHAR(36),             -- tree: session → day → project
  level VARCHAR(20) NOT NULL,        -- 'turn_window', 'session', 'day', 'project'
  summary TEXT NOT NULL,
  embedding BLOB,
  source_from VARCHAR(36),           -- first episode in window
  source_to VARCHAR(36),             -- last episode in window
  entity_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (parent_id) REFERENCES observations(id)
);

-- Semantic memory: entities and facts
CREATE TABLE entities (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,  -- 'file', 'function', 'concept', 'person', 'decision'
  properties JSON,
  embedding BLOB,
  first_seen VARCHAR(36),            -- episode ID
  last_seen VARCHAR(36),
  mention_count INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Relations between entities
CREATE TABLE relations (
  id VARCHAR(36) PRIMARY KEY,
  from_entity_id VARCHAR(36) NOT NULL,
  to_entity_id VARCHAR(36) NOT NULL,
  relation_type VARCHAR(50) NOT NULL, -- 'modifies', 'depends_on', 'decided_by', etc.
  confidence REAL DEFAULT 1.0,
  source_episode_id VARCHAR(36),
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (from_entity_id) REFERENCES entities(id),
  FOREIGN KEY (to_entity_id) REFERENCES entities(id)
);

-- Work tracking (from Scribe/Parchment)
CREATE TABLE work_items (
  id VARCHAR(36) PRIMARY KEY,
  kind VARCHAR(20) NOT NULL,         -- 'goal', 'task', 'spec', 'bug', 'idea', 'decision'
  status VARCHAR(20) DEFAULT 'draft', -- 'draft', 'active', 'complete', 'dismissed'
  title TEXT NOT NULL,
  description TEXT,
  parent_id VARCHAR(36),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (parent_id) REFERENCES work_items(id)
);

-- Links between work items, entities, and episodes
CREATE TABLE links (
  from_id VARCHAR(36) NOT NULL,
  from_type VARCHAR(20) NOT NULL,    -- 'episode', 'observation', 'entity', 'work_item'
  to_id VARCHAR(36) NOT NULL,
  to_type VARCHAR(20) NOT NULL,
  link_type VARCHAR(50) NOT NULL,    -- 'references', 'implements', 'derived_from', 'mentioned_in'
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Why Dolt

- `dolt diff` — see what the memory model changed
- `dolt branch` — speculative memory (what-if scenarios)
- `dolt log` — full audit trail of knowledge changes
- `dolt merge` — combine memory branches after parallel agent work
- SQL interface — Model B can query with standard SQL
- Versioning — roll back bad extractions

## Trackers (from Scribe/Parchment)

Model B maintains several tracker categories as work_items:

| Tracker | Kind | What it tracks |
|---------|------|----------------|
| **Work** | task, bug | Active tasks, bugs, their status and dependencies |
| **Ideation** | idea | Brainstorming, proposals, alternatives considered |
| **Decisions** | decision | Choices made, rationale, who decided, what was rejected |
| **Internal Thinking** | spec | Architecture decisions, design patterns applied |
| **Context** | ref | External references, documentation links, API specs |

These link to episodes (source) and entities (subject) via the `links` table.

## Dual-Model Coordination

### Model B's loop (background)

```
for each new episode (user input, assistant output, tool result):
  1. Store in episodes table
  2. Compute embedding
  3. Extract entities + relations (LLM call)
  4. Update knowledge graph (entities + relations tables)
  5. Check compaction window
     - If window full: summarize → create observation
  6. Update work item trackers if relevant
  7. Link everything via links table
```

### Model B's recall (on user prompt)

```
1. Embed user prompt
2. Vector search: top-K similar episodes + observations
3. Graph walk: entities mentioned in prompt → related entities
4. Work item check: any active tasks related to prompt?
5. Rank by: relevance * recency * importance
6. Return top memories for injection into Model A's context
```

### Model Selection

- **Model A**: User's configured model (Claude Opus, GPT-5, etc.)
- **Model B**: Can be cheaper/smaller — it does extraction, not reasoning
  - Default: same as A (simplest)
  - Recommended: fast model (Claude Haiku, GPT-4o-mini) for cost
  - Embedding: separate embedding model (text-embedding-3-small)

## Integration with Existing Systems

| Existing | How it connects |
|----------|-----------------|
| **Board** | Episodes and observations are Board entries |
| **GenSec** | GenSec's Contract creates work items; Model B tracks them |
| **Broker** | Model B runs as a background agent via the Broker |
| **Compaction** | Replaces the current linear compaction with windowed + tree |
| **Session JSONL** | Migrated to Dolt; JSONL becomes an export format |

## Implementation Phases

| Phase | What | Effort |
|-------|------|--------|
| 5a | Dolt client library (connect, query, schema migration) | Medium |
| 5b | Episode storage (store every I/O in Dolt) | Small |
| 5c | Embedding pipeline (compute + store vectors) | Medium |
| 5d | Moving window compaction with observations | Medium |
| 5e | Entity extraction (Model B's LLM loop) | Medium |
| 5f | Recall injection (vector search + graph walk → context) | Medium |
| 5g | Work item trackers (from Scribe) | Small |
| 5h | Tree index for hierarchical recall | Small |

## Prior Art

| System | What we take |
|--------|-------------|
| **Letta/MemGPT** | Three-tier memory, LLM-managed paging, core/archival/recall |
| **Zep/Graphiti** | Bitemporal episodic subgraphs, entity+relation extraction |
| **Mem0** | Conflict detection, semantic dedup, graph+vector hybrid |
| **Cognee** | Six-stage cognify pipeline, self-improving knowledge graph |
| **Scribe** | Artifact kinds (goal/task/spec/bug), DAG edges, work tracking |
| **Parchment** | ISP store interfaces, FTS5 search, snapshot/restore |
| **Obsidian** | Backlinks, wikilinks, knowledge graph from notes |
| **Observational memory** | Timestamped structured observations, 10x cost reduction |
