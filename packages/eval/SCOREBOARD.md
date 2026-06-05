# Eval Scoreboard

Auto-generated from `benchmark.jsonl`. Do not edit manually — re-runs update this file.

## Run History

| Date | Commit | Model | Pass | Score | OAE |
|---|---|---|---|---|---|
| 2026-06-05 | `94a7c23d` | claude-sonnet-4-5@20250929 | **0/12** (0%) | 0% | 0.0% |
| 2026-05-29 | `b4e6805f` | claude-sonnet-4-5 | **10/12** (83%) | 92% | 2.4% |
| 2026-05-28 | `8542ba42` | claude-sonnet-4-5 | **10/12** (83%) | 92% | 2.4% |

## Per-Evaluation (latest run)

| Evaluation | Status | Score | Trend | Notes |
|---|---|---|---|---|
| PlanRefactoring | ✗ | 0% | ↓ regressed | Expected tool 'fs.read' to be called, but only these were used: [] |
| AuditModule | ✗ | 0% | ↓ regressed | Expected tool 'fs.read' to be called, but only these were used: [] |
| BlastRadius | ✗ | 0% | ↓ regressed | Expected tool 'fs.read' to be called, but only these were used: [] |
| ContextWarming | ✗ | 0% | ↓ regressed | Expected tool 'fs.read' to be called, but only these were used: [] |
| CreateHTTPServer | ✗ | 0% | ↓ regressed | Expected tool 'fs.write' to be called, but only these were used: [] |
| AddTypeExport | ✗ | 0% | ↓ regressed | Expected tool 'fs.read' to be called, but only these were used: [] |
| FixFailingTest | ✗ | 0% | ↓ regressed | Expected tool 'fs.read' to be called, but only these were used: [] |
| RefactorAsync | ✗ | 0% | ↓ regressed | Expected tool 'fs.read' to be called, but only these were used: [] |
| WriteMiddleware | ✗ | 0% | ↓ regressed | Expected tool 'fs.read' to be called, but only these were used: [] |
| ProposeFirst | ✗ | 0% | ↓ | Expected tool 'fs.read' to be called, but only these were used: [] |
| MemoRecall | ✗ | 0% | ↓ | Expected tool 'fs.read' to be called, but only these were used: [] |
| ApproveProposal | ✗ | 0% | ↓ regressed | File not found: src/truncate.ts |

## Aggregate Stats (all runs)

| Evaluation | Runs | Pass Rate | Best Score | Latest |
|---|---|---|---|---|
| PlanRefactoring | 3 | 67% | 100% | 0% |
| AuditModule | 3 | 67% | 100% | 0% |
| BlastRadius | 3 | 67% | 100% | 0% |
| ContextWarming | 3 | 67% | 100% | 0% |
| CreateHTTPServer | 3 | 67% | 100% | 0% |
| AddTypeExport | 3 | 67% | 100% | 0% |
| FixFailingTest | 3 | 67% | 100% | 0% |
| RefactorAsync | 3 | 67% | 100% | 0% |
| WriteMiddleware | 3 | 67% | 50% | 0% |
| ProposeFirst | 3 | 0% | 100% | 0% |
| MemoRecall | 3 | 0% | 100% | 0% |
| ApproveProposal | 3 | 67% | 50% | 0% |

_Last updated: 2026-06-05 10:57:10 UTC_
