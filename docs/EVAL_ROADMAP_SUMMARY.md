# Alef Evaluation Roadmap: Executive Summary

## Current State

Alef has an internal evaluation harness (`packages/eval`) with 12 custom coding tasks achieving **92% score, 100% pass rate** with Claude Sonnet 4-5. However, no standardized external benchmark coverage exists for comparison with competing frameworks.

## Problem Statement

Without external benchmark validation, Alef cannot:
- Credibly claim competitive performance vs Claude Computer Use, OpenAI Operator, Gemini agents
- Identify capability gaps vs industry leaders
- Track improvement over time against stable baselines
- Attract users/investors without proof of real-world performance

## Recommended Solution

Implement a **tiered evaluation strategy** covering:

1. **SWE-bench Verified** (500 coding tasks) — industry standard, apples-to-apples comparison
2. **Expanded internal suite** (12 → 50 tasks) — regression protection, fast iteration
3. **TAU-bench** (airline domain) — tool-use validation, multi-turn orchestration

**Defer**: WebVoyager (requires browser automation), OSWorld (requires computer use API).

## Success Metrics

### Phase 1: Baseline (Weeks 1-4)

| Metric | Target | Status |
|--------|--------|--------|
| Internal eval pass rate | 100% | ✓ (current) |
| SWE-bench integration | Harness runs end-to-end | TODO |
| Initial SWE-bench score | 40%+ pass@1 | TODO |
| Cost per task | <$2 | TODO |

### Phase 2: Optimization (Weeks 5-8)

| Metric | Target | Status |
|--------|--------|--------|
| SWE-bench Verified | 60%+ pass@1 | TODO |
| Cost efficiency | <$2/task | TODO |
| Tool error rate (OAE) | <5% | TODO |
| Leaderboard submission | Public validation | TODO |

### Phase 3: Multi-Turn (Weeks 9-12)

| Metric | Target | Status |
|--------|--------|--------|
| TAU-bench (airline) | 40%+ pass@1 | TODO |
| Multi-turn stability | Pass@8 > 25% | TODO |
| Policy compliance | <5% violations | TODO |

## Budget Requirements

| Phase | Tasks | Model | Estimated Cost | Risk |
|-------|-------|-------|----------------|------|
| Internal expansion | 50 | Claude Sonnet 4-5 | $50 | Low (already working) |
| SWE-bench sample | 50 | Claude Sonnet 4-5 | $100 | Medium (new harness) |
| SWE-bench full | 500 | Claude Sonnet 4-5 | $500-1000 | High (large budget) |
| TAU-bench | 50 × 8 | Sonnet + Haiku | $240 | Medium (user simulator) |
| **Total Phase 1-3** | | | **$890-1390** | |

**Cost mitigation**: 
- Start with samples before full runs
- Set per-task cost caps ($5)
- Abort on budget overruns

## Competitive Positioning

### SWE-bench Verified Leaderboard (Target)

| Framework | Model | Pass@1 | Cost/Task | Notes |
|-----------|-------|--------|-----------|-------|
| Claude Fable 5 | Anthropic | 95% | N/A | Top performer |
| SWE-agent | Sonnet 4-5 | 72.8% | ~$2 | Current leader (open source) |
| **Alef (target)** | **Sonnet 4-5** | **60%+** | **<$2** | **Competitive baseline** |
| Devin | Unknown | ~70% | N/A | Commercial, black box |
| OpenHands | Various | ~50% | N/A | Open source |

### Key Differentiators

**Alef's strengths** (vs competitors):
- **Organ framework**: Modular, composable tools (vs monolithic scaffolding)
- **File-system aware**: Symbol-level code navigation (code-intel), diff-based edits (fs.edit)
- **Development-focused**: Coding, debugging, testing workflows (vs general assistance)
- **Open source**: Inspectable traces, forkable code (vs black box APIs)

**Alef's gaps** (vs competitors):
- No browser automation (yet) — OpenAI Operator leads here
- No computer use API (yet) — Claude Computer Use leads here
- Unproven on benchmarks — need baseline validation

**Strategic focus**: Double down on coding competency (SWE-bench) before exploring adjacent domains (web, computer use).

## Implementation Plan

### Week 1-2: Internal Expansion
- Expand eval suite from 12 → 50 tasks
- Run with Claude Sonnet 4-5, Opus 4-6, GPT-5
- Capture baseline: pass@1, cost, latency, tool use patterns

### Week 3-4: SWE-bench Integration
- Implement `SWEBenchAdapter` (Docker-based execution)
- Run 50-task stratified sample
- Measure initial pass@1 (target: 40%+)
- Identify failure modes (tool errors? planning? verification?)

### Week 5-6: Tool Refinement
- Analyze OTel traces from SWE-bench runs
- Optimize `organ-fs`, `organ-code-intel`, `organ-shell`
- Add missing tools (e.g., `git.apply-patch`, `test.run`)
- Reduce operational agent error (OAE) rate

### Week 7-8: Full SWE-bench Run
- Execute 500-task full suite (budget: $500-1000)
- Submit to SWE-bench leaderboard
- Publish results to `SCOREBOARD.md`
- Generate comparison report (Alef vs competitors)

### Week 9-10: TAU-bench Integration
- Implement user simulator (LLM-based customer)
- Build airline API + database
- Create `AirlineOrgan` (search, book, cancel tools)
- Run 50-task suite (pass@8 for stability)

### Week 11-12: Dashboard & CI/CD
- Build unified metrics dashboard (HTML + charts)
- Set up PR regression gate (internal eval, 100% pass)
- Set up nightly SWE-bench runs
- Publish dashboard to GitHub Pages

## Risk Mitigation

### Technical Risks

**SWE-bench Gaming**: Recent research shows benchmarks can be gamed (agent exploits test harness).
- **Mitigation**: Use SWE-bench Verified (curated tasks) + manual spot checks.

**Cost Overruns**: Full SWE-bench run costs $500-1000.
- **Mitigation**: Start with 50-task sample; set per-task cost caps; abort on overruns.

**Benchmark Reproducibility**: WebVoyager tasks drift (websites change).
- **Mitigation**: Focus on SWE-bench (stable, Docker-based) and internal evals.

### Strategic Risks

**Positioning Ambiguity**: Is Alef a coding agent or general assistant?
- **Mitigation**: Focus on coding benchmarks (SWE-bench) first; explore general assistance later.

**Leaderboard Obsession**: Risk of over-optimizing for benchmarks ("teaching to the test").
- **Mitigation**: Maintain internal eval suite (captures real workflows); use benchmarks for calibration only.

## Decision Points

### Week 2: Internal Baseline Review
- **Question**: Is Alef's current performance (92% on internal evals) competitive?
- **Decision**: If yes, proceed to SWE-bench integration. If no, optimize tooling first.

### Week 4: SWE-bench Sample Results
- **Question**: Did Alef achieve 40%+ pass@1 on 50-task sample?
- **Decision**: If yes, approve $1000 budget for full run. If no, analyze failure modes and iterate.

### Week 8: SWE-bench Full Results
- **Question**: Did Alef achieve 60%+ pass@1 on full 500-task suite?
- **Decision**: If yes, submit to leaderboard and proceed to TAU-bench. If no, reassess strategy.

### Week 12: Phase 3 Completion
- **Question**: Should we invest in WebVoyager/OSWorld (browser + computer use)?
- **Decision**: Only if SWE-bench results are strong (>60%) and budget allows.

## Recommended Next Steps

1. **Immediate** (this week):
   - Review and approve this roadmap
   - Allocate $100 budget for internal expansion + SWE-bench sample
   - Assign engineering team to Phase 1 implementation

2. **Week 1-2**:
   - Expand internal eval suite (12 → 50 tasks)
   - Run baseline with multiple models
   - Generate initial metrics report

3. **Week 3-4**:
   - Implement SWE-bench integration
   - Run 50-task sample
   - Present results and request budget for full run

4. **Week 8**:
   - Complete SWE-bench full run
   - Submit to public leaderboard
   - Publish blog post: "Alef Evaluation Results"

5. **Week 12**:
   - Complete TAU-bench integration
   - Generate competitor comparison report
   - Decide on Phase 4 (exploration) priorities

## Success Criteria

### Minimum Viable Outcome (Phase 1-2)
- ✅ SWE-bench Verified integration complete
- ✅ 40%+ pass@1 on SWE-bench (proves Alef is functional)
- ✅ Internal eval suite 100% pass (no regressions)
- ✅ Cost per task <$3 (economically viable)

### Competitive Outcome (Phase 2)
- ✅ SWE-bench Verified 60%+ pass@1 (mid-tier performance)
- ✅ Public leaderboard submission
- ✅ Cost per task <$2 (matches SWE-agent)
- ✅ Published blog post with results

### Differentiated Outcome (Phase 3)
- ✅ TAU-bench 40%+ pass@1 (proves multi-turn capability)
- ✅ Tool-use metrics demonstrate efficiency vs competitors
- ✅ Dashboard published to GitHub Pages
- ✅ Community contributions to eval suite

## Conclusion

Alef has strong foundational capabilities (internal evals show 92% performance) but lacks external benchmark validation. Implementing SWE-bench Verified coverage will:

1. **Validate** Alef's competitive positioning vs industry leaders
2. **Identify** capability gaps requiring tool/prompt optimization
3. **Track** improvement over time against stable baselines
4. **Attract** users/investors with credible performance claims

**Recommendation**: Approve Phase 1-2 ($100-1000 budget) and proceed with SWE-bench integration. Reassess after Week 4 sample results before committing to full run.

---

**See also**:
- [EVALUATION_STRATEGY.md](./EVALUATION_STRATEGY.md) — Detailed analysis of benchmarks, metrics, and comparison strategy
- [BENCHMARK_INTEGRATION_GUIDE.md](./BENCHMARK_INTEGRATION_GUIDE.md) — Technical implementation specifications
