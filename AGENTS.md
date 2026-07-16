# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct
- Answer the question first before making edits or running implementation commands

## Tools

Use MCP servers when they are available and relevant. Do not fall back to Bash, file reads, or direct API calls when an MCP tool covers the same operation. Before reading a file manually, check if an MCP tool can fetch it. Before writing a markdown file to disk, check if the artifact belongs in Scribe.

## Session Debugging

When diagnosing hung tools, missing history, empty TUI, vanished events, or "why did this session fail" — use Alef's debug CLI, not raw SQL.

```bash
alef log sessions                         # list sessions (newest first)
alef log chain [session-id]               # round-trip link check
alef log events <id> --adapter shell      # tool-specific events
alef log events <id> --type 'llm.tool-%'  # tool start/end/stall
alef log events <id> --payload <substr>   # payload search
alef log trace <id> <correlationId>       # one turn
alef debug session [id]                   # unpaired command/event check
```

Canonical playbook: `packages/cli/src/skills/debug-alef/SKILL.md` (also `.cursor/skills/debug-alef`).

**Never open `alef.db` with `sqlite3` first.** That is the escape hatch only when `alef log` cannot express the query — then extend `alef log` (and file a Scribe need), do not normalize raw SQL.

## Prior Art & Existing Config

Before changing any config or theme: grep for what already exists. Never introduce a new dependency (true color, a new crate, a new env var) without first checking whether it is already present and working. If the existing code works, the fix is the smallest possible delta to the existing code — not a replacement.

## Discussion vs Implementation

When asked to discuss, discuss only. No code, no file changes, no artifact creation unless explicitly requested. "Let's think about X" means think, not build.

## Quality Gate

After every substantive code change, in order: build → lint → test. Never declare done without passing all three. Fix failures before moving on.

Run `npm run check` after every logical group of changes — not only before git commit. The pre-commit hook is the last gate, not the primary feedback loop.

LSP inline diagnostics (from Edit/Write tools) show type errors for the edited file only. They miss biome warnings, eslint semantic rules, and cross-file issues. `npm run check` catches all of them.

## Commands

```bash
npm run check:fast     # biome + tsc + eslint + adapter lint (pre-commit)
npm run check          # check:fast + unit tests + blueprints + browser smoke (CI)
npm run check:test     # unit tests across all packages in parallel
```

- `npm run check` does not run integration or real-LLM tests
- NEVER run: `npm run dev`, `npm run build`, `npm test`
- Run specific tests with vitest from monorepo root:
  `npx vitest run packages/<group>/<name>/test/specific.test.ts`
- If you create or modify a test file, run it and iterate until it passes

## Commits

`<type>: <what changed>` — lowercase, no period, 72 chars max.
Types: `feat` `fix` `refactor` `test` `docs` `chore` `ci`

Never:
- Bullet lists of changed files
- Tracker IDs (Jira, Scribe, RP) in the subject line
- Mix unrelated changes in one commit

## Comments

Zero by default. One line only when the WHY is non-obvious to a reader who knows the codebase.

Never:
- Explain what the code does — the code says what; the comment says why
- Reference ticket, bug, or spec IDs — git blame carries that context
- Write block comments restating the function signature or parameter names
- Narrate the implementation step by step

Legitimate: external constraints, non-obvious regex, OS/API quirks that would surprise an expert.

## Adapter Framework

Adapters live in `packages/tools/*/`. Each adapter depends only on `@dpopsuev/alef-kernel` and `zod`.

### Creating a new adapter

Use the scaffold command — it generates all required files:
```bash
npx tsx scripts/create-adapter.ts weather   # creates packages/adapter-weather/ with 5 files
npm install                                  # register workspace package
```

Adapter names resolve by convention: `"weather"` in a blueprint resolves to `@dpopsuev/alef-adapter-weather`. No registry entry needed.

### Before writing adapter code

1. Read `packages/core/kernel/src/framework.ts` — the `defineAdapter()` contract and `ActionMap` type
2. Read `packages/core/kernel/src/buses.ts` — `AdapterContributions`, `ToolDefinition`, `ContextAssemblyHandler`
3. Read an existing adapter as reference (e.g. `packages/tools/fs/src/adapter.ts`)
4. Run `adapterComplianceSuite()` from `@dpopsuev/alef-testkit/adapter` on the result

Never write adapter code from memory or training data. The API shape must come from reading the source. Adapters that don't use `defineAdapter()` cannot mount on the bus and will fail silently.

Use `explainAdapter(adapter)` from `@dpopsuev/alef-kernel` to inspect any adapter's tools, contributions, and directives.

### Authoring an adapter

```ts
import { defineAdapter, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";

export function createWeatherAdapter(opts: WeatherAdapterOptions) {
  return defineAdapter("weather", {
    "command/weather.forecast": typedAction(TOOL, async (ctx) => {
      return withDisplay({ result }, { text: "...", mimeType: "text/plain" });
    }),
  }, {
    description: "One sentence.",
    directives: ["Guidance for the LLM."],
    contributions: {
      "context.assemble": phaseHandler,  // optional: participate in pre-LLM pipeline
      "agent.run": agentRunHandler,      // optional: extend agent.run behaviour
      "skills": [skillBook],             // optional: contribute skill books
    },
  });
}
```

Action map key prefix determines bus direction: `"command/weather.forecast"` subscribes Command, `"event/adapter.loaded"` subscribes Event.

### Cross-adapter integration (contributions map)

Adapters declare capabilities via `contributions` in `defineAdapter` opts. Aggregator adapters collect them from `event/adapter.loaded`. No optional callbacks, no manual wiring.

Current contribution slots:
- `"agent.run"?: AgentRunContribution` — extend `agent.run({ text, playbook? })` with schema fields and behaviour
- `"context.assemble"?: ContextAssemblyHandler` — participate in the pre-LLM pipeline (tools + messages transform)
- `"skills"?: SkillBook[]` — contribute playbooks to the Skills adapter library

Adding a new slot: add the type to `AdapterContributions` in `core/kernel/src/buses.ts`, implement a composite aggregator adapter, wire via `event/adapter.loaded`.

### Lint rules (enforced by `npm run check:adapters`)

- `[RAWTIMER]` — raw `setTimeout`/`setInterval` in adapter `src/` is a hard gate. Suppress with `// lint-ignore: RAWTIMER <reason>` when it is a real deadline, not a stall detector.
- Adapters with tools must declare `description` and non-empty `directives`.
- Adapters cannot import from `packages/agent` or `packages/core/testkit` — kernel + zod only.

## Import Boundaries (enforced by `eslint-plugin-boundaries`)

The runner package enforces a DAG on its subdirectories. Subdirectories
can import from root files, but NOT from each other (except where the
DAG explicitly allows). This prevents intra-package cycles.

**DAG rules** (defined in `eslint.config.ts`):

```
root → model, session-lifecycle, tui, commands, identity, strategies, workflow
model → root
session-lifecycle → root
tui → root, commands
commands → root, model, tui
identity → root
strategies → root
workflow → root
```

**Violations are lint errors.** If a subdirectory needs something from
another subdirectory, inject it from root (the composition layer) via
constructor params or callbacks — never import across subdirectories.

Example: `session-lifecycle/handle.ts` needs model building. Instead of
importing `../model/index.js`, it receives a `modelFactory: (id) => Model`
callback injected by `local-session.ts` (root).

## Architecture

Package structure: `packages/core/*` (platform), `packages/tools/*` (adapters), `packages/ui/*` (TUI/web), `packages/profiles/*` (blueprint configs), `packages/agent` (headless agent runtime).

Production agent: `packages/profiles/coding` — the full coding agent blueprint.
- Canonical adapter set: fs, shell, nodesh, code-intel, web, agent, factory, skills
- adapter-agent — unified delegation + child lifecycle (agent.run, agent.spawn, agent.ask, agent.race, agent.converse, agent.kill)

Microkernel: `packages/core/kernel` — buses, adapter framework, binding chain, contributions. No adapter names, no application concerns.

Runtime: `packages/core/runtime` — Agent class, AgentController, assembleAgentServer, InProcessStrategy.

Session: `packages/core/session` — SessionStore, TurnAssembler, context compaction. Must not reference adapter-specific event names.

Gateway: `packages/tools/gateway` — HTTP/SSE bridge (RouterAdapter). Endpoints: /events, /message, /state, /control, /cancel, /reload, /history.

Agent: `packages/agent` — headless agent server. TUI is a client that attaches via Session interface. Daemon mode (`--daemon`), attach (`--attach`), list (`--list`), kill (`--kill`).

Security: OCAP via `writableRoots` (injected by materializer from config.security.writable_roots). No `allowAbsolutePaths`.

## **CRITICAL** Git Rules

- **Commit early and often.** Each logical change gets its own commit immediately after tests pass. Never accumulate more than one concern in the working tree.
- **ONLY commit files YOU changed in THIS session**
- NEVER use `git add -A` or `git add .`
- ALWAYS use `git add <specific-file-paths>`
- Run `git status` before committing; verify only your files are staged

Forbidden: `git reset --hard` · `git checkout .` · `git clean -fd` · `git stash` · `git commit --no-verify` · `git commit -n` · `HUSKY=0`

Rebase conflicts: resolve only in files you modified. Abort and ask if the conflict is in a file you did not touch. Never force push.

## Naming

Full names over abbreviations. The reader's time is worth more than the writer's keystrokes.

- Channel ends: `event_sender` / `chunk_receiver` — not `event_tx` / `chunk_rx`
- Task handles: name what the task does — `chunk_forwarder`, not `fwd`
- Local variables: `event` not `ev`, `config` not `cfg`, `message` not `msg`
- Wrap raw channels behind intent-named structs

Established domain abbreviations are canonical, not shortcuts — keep: `llm`, `lsp`, `tui`, `mcp`, `http`, `id`, `ui`

## KISS

1. **No speculative abstraction** — no interface with one implementation, no type parameter used once
2. **No feature creep** — implement only what the task describes
3. **No unnecessary layers** — call the thing directly; add a layer only with a proven need
4. **No library addiction** — stdlib first; import only when stdlib is insufficient
5. **No comment bloat** — zero comments by default; one line only when the WHY is non-obvious
6. **No error theater** — validate only at system boundaries; trust internal code
7. **No backward compatibility theater** — delete unused code; git has history

## Output

- Names over IDs: "DPLL pin-reset collapse (OCPBUGS-85091)" not "OCPBUGS-85091"
- Every external reference gets its full URL
- When wrong: correct and move on. No apologies.

## Language and Toolchain

TypeScript + Node.js + Vitest. Never introduce Python or Bash scripts where TypeScript tests exist. Match the existing stack.

Before designing, search for prior art. Name the pattern before writing code.
