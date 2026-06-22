# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct
- Answer the question first before making edits or running implementation commands

## Tools

Use MCP servers when they are available and relevant. Do not fall back to Bash, file reads, or direct API calls when an MCP tool covers the same operation. Before reading a file manually, check if an MCP tool can fetch it. Before writing a markdown file to disk, check if the artifact belongs in Scribe.

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
npm run check          # biome + tsgo + eslint + organ lint + unit tests + browser smoke
npm run check:test     # unit tests across all packages in parallel (~52s)
```

- `npm run check` does not run integration or real-LLM tests
- NEVER run: `npm run dev`, `npm run build`, `npm test`
- Run specific tests from the package root (not from monorepo root):
  `cd packages/<name> && npx vitest run test/specific.test.ts`
- Monorepo root vitest cannot resolve path aliases — always run per-package
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

## Organ Framework

Organs live in `packages/organ-*`. Each organ depends only on `@dpopsuev/alef-kernel` and `zod`.

### Creating a new organ

Use the scaffold command — it generates all required files:
```bash
make organ NAME=weather          # creates packages/organ-weather/ with 5 files
npm install                       # register workspace package
```

Organ names resolve by convention: `"weather"` in a blueprint resolves to `@dpopsuev/alef-organ-weather`. No registry entry needed.

### Before writing organ code

1. Read `packages/kernel/src/framework.ts` — the `defineOrgan()` contract and `ActionMap` type
2. Read `packages/kernel/src/buses.ts` — `OrganContributions`, `ToolDefinition`, `ContextAssemblyHandler`
3. Read an existing organ as reference (e.g. `packages/organ-fs/src/organ.ts`)
4. Run `organComplianceSuite()` from `@dpopsuev/alef-testkit/organ` on the result

Never write organ code from memory or training data. The API shape must come from reading the source. Organs that don't use `defineOrgan()` cannot mount on the nerve and will fail silently.

Use `explainOrgan(organ)` from `@dpopsuev/alef-kernel` to inspect any organ's tools, contributions, and directives.

### Authoring an organ

```ts
import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";

export function createXOrgan(opts: XOrganOptions) {
  return defineOrgan("x", {
    "motor/x.do": typedAction(TOOL, async (ctx) => {
      return withDisplay({ result }, { text: "...", mimeType: "text/plain" });
    }),
  }, {
    description: "One sentence.",
    directives: ["Guidance for the LLM."],
    contributions: {
      "llm.phase": phaseHandler,   // optional: participate in pre-LLM pipeline
      "agent.run": agentRunHandler, // optional: extend agent.run behaviour
      "skills": [skillBook],        // optional: contribute skill books
    },
  });
}
```

Action map key prefix determines bus direction: `"motor/x.do"` subscribes Motor, `"sense/organ.loaded"` subscribes Sense.

### Cross-organ integration (contributions map)

Organs declare capabilities via `contributions` in `defineOrgan` opts. Aggregator organs collect them from `sense/organ.loaded`. No optional callbacks, no manual wiring.

Current contribution slots:
- `"agent.run"?: AgentRunContribution` — extend `agent.run({ text, playbook? })` with schema fields and behaviour
- `"llm.phase"?: PhaseStageHandler` — participate in the pre-LLM pipeline (tools + messages transform)
- `"skills"?: SkillBook[]` — contribute playbooks to the Skills Organ library

Adding a new slot: add the type to `OrganContributions` in `kernel/src/buses.ts`, implement a composite aggregator organ, wire via `sense/organ.loaded`.

### Lint rules (enforced by `npm run check:organs`)

- `[RAWTIMER]` — raw `setTimeout`/`setInterval` in organ `src/` is a hard gate. Suppress with `// lint-ignore: RAWTIMER <reason>` when it is a real deadline, not a stall detector.
- Organs with tools must declare `description` and non-empty `directives`.
- Organs cannot import from `packages/runner` or `packages/testkit` — kernel + zod only.

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

Production agent: `packages/alef-coding-agent` — the full coding agent stack.
- `CODING_AGENT_BLUEPRINT` — canonical organ set (fs, shell, nodesh, code-intel, web, agent, factory, skills)
- organ-agent — unified delegation + child lifecycle (agent.run, agent.spawn, agent.ask, agent.race, agent.converse, agent.kill)

Microkernel: `packages/kernel` — buses, organ framework, binding chain, contributions. No organ names, no application concerns.

Runtime: `packages/runtime` — Agent class, InProcessStrategy, RemoteStrategy (HTTP/SSE with stall watchdog + AbortSignal).

Security: OCAP via `writableRoots` (injected by materializer from config.security.writable_roots). No `allowAbsolutePaths`.

Bus protocol constants (e.g. `VALIDATE_REQUEST`, `DIALOG_MESSAGE`) belong in `kernel/src/protocols.ts` only when they define a cross-organ handshake. Organ-specific event names stay in the organ that owns them.

The `session` package must not reference organ-specific event names (Feature Envy). Turn boundaries are detected structurally.

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
