# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct

## Code Quality

- Read files in full before making wide-ranging changes or when investigating something. Do not rely on search snippets for broad changes.
- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** — no `await import("./foo.js")`, no `import("pkg").Type` in type positions. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors; upgrade the dependency instead
- Always ask before removing functionality that appears intentional
- Do not preserve backward compatibility unless explicitly asked

## Comments

Zero by default. One line only when the WHY is non-obvious to a reader who knows the codebase. Never explain what the code does. Delete:

- What-comments (`// Resolve agent definition` above `resolveInstanceConfig(...)`)
- Decision lore (`// Using X because Y was slower`)
- Alternative comparisons (`// Unlike foo(), this doesn't...`)
- Version tags (`// Added in v0.2`)
- Future-state markers (`// Replace once X ships`)

Legitimate: external constraints, non-obvious regex, OS/API quirks that would surprise an expert.

## Commands

- After code changes: `npm run check` — get full output, fix all errors and warnings before committing
- `npm run check` does not run tests
- NEVER run: `npm run dev`, `npm run build`, `npm test`
- Run specific tests from the package root: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`
- If you create or modify a test file, run it and iterate until it passes

## Commits

- One semantic change per commit
- `type(scope): summary` — lowercase, no period, 72 chars max
- Types: `feat` `fix` `refactor` `test` `docs` `chore` `ci` `perf`
- Include `closes ALE-TSK-NNN` when a commit resolves a Scribe task

## Organ Framework

Organs live in `packages/organ-*`. Each organ depends only on `@dpopsuev/alef-spine` and `zod`.

Key spine exports:
- `defineOrgan(name, actionMap, opts)` — create an organ
- `typedAction(tool, handler)` / `typedStreamAction(tool, handler)` — typed handlers
- `tool(name, description, schema)` — OrganTool with `.action()` / `.stream()`; motor key is `motor/${name}`
- `BaseOrganOptions` / `TimeoutOrganOptions` / `spreadOrganOptions(opts)`
- `withTruncatedDisplay(data, content, opts?)` — truncate + `_display` block in one call
- `directive(...lines)` — sugar for `string[]` directives array

Action map keys carry the bus prefix: `"motor/fs.read"` subscribes Motor, `"sense/dialog.message"` subscribes Sense.

The `llm.phase` seam has `ordered-pipeline` cardinality — multiple organs may subscribe. Responses are collected within a 30ms quiescence window and merged field-by-field.

## Memory / Context Scoring

Weights in `ContextWindowPolicy` (`packages/runner/src/turn-assembler.ts`):
- `queryMatchWeight` — term overlap between turn content and current query (default 0.40)
- `accessFrequencyWeight` — assembly hit count normalised to [0,1] (default 0.30)
- `sessionRecencyWeight` — ordinal turn index (not wall-clock) (default 0.30)

Unseen turns score `hitCount=1` (neutral), not 0 — cold-start fairness.

## Architecture

Roadmap: `ALE-DOC-2` in Scribe. Current phase: Phase 1 (Memory Foundation).

Active specs:
- `ALE-SPC-55` — Memory Pyramid (five-level context model)
- `ALE-SPC-57` — TUI render caching
- `ALE-SPC-54` — Organ SDK (migration of 12 organs pending)

## **CRITICAL** Git Rules

- **ONLY commit files YOU changed in THIS session**
- NEVER use `git add -A` or `git add .`
- ALWAYS use `git add <specific-file-paths>`
- Run `git status` before committing; verify only your files are staged

Forbidden: `git reset --hard` · `git checkout .` · `git clean -fd` · `git stash` · `git commit --no-verify`

Rebase conflicts: resolve only in files you modified. Abort and ask if the conflict is in a file you did not touch. Never force push.
