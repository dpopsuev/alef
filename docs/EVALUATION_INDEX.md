# Alef Agent Evaluation Documentation Index

## Overview

This directory contains comprehensive evaluation strategy and implementation documentation for the Alef agent framework. Documents are organized by audience and purpose.

---

## For Decision Makers

**Start here**: [EVAL_ROADMAP_SUMMARY.md](./EVAL_ROADMAP_SUMMARY.md)

Concise executive summary covering:
- Current state (92% on internal evals, no external benchmark coverage)
- Recommended solution (SWE-bench + TAU-bench prioritization)
- Budget requirements ($890-1390 for Phase 1-3)
- Success criteria (60%+ SWE-bench pass@1)
- Decision points (Week 2, Week 4, Week 8 gates)
- Risk mitigation strategies

**Reading time**: 15 minutes

**Key takeaway**: Alef needs external benchmark validation. Invest $100-1000 in SWE-bench integration to establish competitive baseline.

---

## For Engineers

**Start here**: [BENCHMARK_INTEGRATION_GUIDE.md](./BENCHMARK_INTEGRATION_GUIDE.md)

Technical implementation specifications for:
- SWE-bench integration (Docker environments, test harness, dataset loading)
- TAU-bench integration (user simulator, domain APIs, multi-turn orchestration)
- Metrics collection (unified schema, OTel traces, cost tracking)
- CI/CD integration (regression gates, nightly runs, leaderboard submission)

**Reading time**: 30 minutes

**Key takeaway**: Extend `packages/eval` with benchmark adapters. Reuse existing infrastructure (DockerSpace, evaluation runner, scoreboard).

**Implementation checklist**:
- [ ] Phase 1: SWE-bench (Weeks 1-4)
- [ ] Phase 2: TAU-bench (Weeks 5-8)
- [ ] Phase 3: Dashboard & CI/CD (Weeks 9-10)

---

## For Researchers

**Start here**: [EVALUATION_STRATEGY.md](./EVALUATION_STRATEGY.md)

Deep analysis covering:
- Benchmark landscape (SWE-bench, TAU-bench, WebVoyager, OSWorld)
- Current SOTA performance (Claude, GPT, Gemini baselines)
- Performance metrics framework (pass@k, cost, latency, behavioral)
- Baseline establishment strategy (internal → sample → full run)
- Competitor comparison methodology (apples-to-apples evaluation)
- Open questions & risks (gaming, reproducibility, cost overruns)

**Reading time**: 45 minutes

**Key takeaway**: SWE-bench Verified is the industry standard for coding agents. TAU-bench validates tool-use patterns. WebVoyager/OSWorld are adjacent but not core competency.

---

## For Data Scientists

**Start here**: [METRICS_REFERENCE.md](./METRICS_REFERENCE.md)

Comprehensive metrics definitions:
- Primary success metrics (Pass@1, Pass@k, partial credit)
- Cost metrics (per task, per success, token efficiency)
- Latency metrics (wall clock, per turn, tool overhead)
- Behavioral metrics (OAE, turn count, error recovery, trajectory efficiency)
- Quality metrics (code quality, policy compliance, safety)
- Tool use metrics (frequency, patterns, success rate)

**Reading time**: 20 minutes

**Key takeaway**: No single metric tells the full story. Track success + cost + latency + behavioral metrics together. Avoid vanity metrics and misleading averages.

---

## Document Dependency Graph

```
EVAL_ROADMAP_SUMMARY.md (executive summary)
   ├─ references → EVALUATION_STRATEGY.md (detailed analysis)
   ├─ references → BENCHMARK_INTEGRATION_GUIDE.md (implementation)
   └─ references → METRICS_REFERENCE.md (definitions)

EVALUATION_STRATEGY.md (research depth)
   ├─ Section 3: Performance Metrics → METRICS_REFERENCE.md
   ├─ Section 5: Evaluation Infrastructure → BENCHMARK_INTEGRATION_GUIDE.md
   └─ Section 7: Implementation Roadmap → EVAL_ROADMAP_SUMMARY.md

BENCHMARK_INTEGRATION_GUIDE.md (engineering spec)
   ├─ Section 3: Metrics Collection → METRICS_REFERENCE.md
   ├─ Section 1-2: SWE-bench/TAU-bench → EVALUATION_STRATEGY.md
   └─ Section 5: Implementation Checklist → EVAL_ROADMAP_SUMMARY.md

METRICS_REFERENCE.md (data science)
   ├─ Referenced by all other docs
   └─ Standalone reference (no dependencies)
```

---

## Quick Navigation by Question

### "What benchmarks should Alef run?"
→ [EVALUATION_STRATEGY.md § 2: Recommended Benchmark Prioritization](./EVALUATION_STRATEGY.md#2-recommended-benchmark-prioritization)

**Answer**: SWE-bench Verified (Tier 1), TAU-bench (Tier 2), WebVoyager/OSWorld (Tier 3, deferred).

---

### "How much will this cost?"
→ [EVAL_ROADMAP_SUMMARY.md § Budget Requirements](./EVAL_ROADMAP_SUMMARY.md#budget-requirements)

**Answer**: $890-1390 for Phase 1-3 (internal expansion + SWE-bench + TAU-bench).

---

### "How does Alef compare to Claude Computer Use?"
→ [EVALUATION_STRATEGY.md § 6: Comparison to Competitors](./EVALUATION_STRATEGY.md#6-comparison-to-competitors)

**Answer**: Alef is coding-focused (file system, code analysis) vs Claude's computer control (screenshot, mouse/keyboard). Overlap: SWE-bench (coding tasks). Differentiation: Organ framework, open source, lower-level control.

---

### "What is Pass@k and why does it matter?"
→ [METRICS_REFERENCE.md § Pass@k (Consistency Rate)](./METRICS_REFERENCE.md#passk-consistency-rate)

**Answer**: Percentage of tasks where ≥1 of k attempts succeeds. Measures consistency/reliability. Low pass@1 + high pass@5 = capable but inconsistent. Use pass@1 for production, pass@5 for capability exploration.

---

### "How do I implement SWE-bench integration?"
→ [BENCHMARK_INTEGRATION_GUIDE.md § 1: SWE-bench Integration](./BENCHMARK_INTEGRATION_GUIDE.md#1-swe-bench-integration)

**Answer**: (1) Load dataset, (2) Create DockerSpace with pre-built images, (3) Run agent with formatted prompt, (4) Extract patch, (5) Apply patch and run tests, (6) Collect metrics.

---

### "What metrics should I track in CI/CD?"
→ [METRICS_REFERENCE.md § Metric Selection Guide](./METRICS_REFERENCE.md#metric-selection-guide)

**Answer**: Regression testing: Pass@1 (must be 100%) + cost (budget alert). Capability eval: Pass@1, Pass@5, cost, latency, tool use patterns.

---

### "When should we decide to proceed with full SWE-bench run?"
→ [EVAL_ROADMAP_SUMMARY.md § Decision Points](./EVAL_ROADMAP_SUMMARY.md#decision-points)

**Answer**: Week 4 decision point. If 50-task sample achieves 40%+ pass@1, approve $1000 budget for full 500-task run. If <40%, analyze failure modes and iterate.

---

## Implementation Phases Summary

### Phase 1: Baseline (Weeks 1-4)
**Goal**: Establish current performance and validate SWE-bench integration.

**Deliverables**:
- 50-task internal eval suite (expanded from 12)
- SWE-bench harness (Docker-based, end-to-end functional)
- Initial SWE-bench score (40%+ pass@1 target)
- Baseline report (Alef vs leaderboard)

**Budget**: $100 (sample runs)

**Docs**: 
- [BENCHMARK_INTEGRATION_GUIDE.md § 1: SWE-bench Integration](./BENCHMARK_INTEGRATION_GUIDE.md#1-swe-bench-integration)
- [EVAL_ROADMAP_SUMMARY.md § Week 1-4](./EVAL_ROADMAP_SUMMARY.md#week-1-2-internal-expansion)

---

### Phase 2: Optimization (Weeks 5-8)
**Goal**: Achieve competitive SWE-bench performance and submit to leaderboard.

**Deliverables**:
- SWE-bench Verified 60%+ pass@1
- Cost per task <$2
- OAE (operational agent error) <5%
- Public leaderboard submission

**Budget**: $500-1000 (full 500-task run)

**Docs**:
- [BENCHMARK_INTEGRATION_GUIDE.md § 1.3: Cost Estimates](./BENCHMARK_INTEGRATION_GUIDE.md#13-cost-estimates)
- [EVALUATION_STRATEGY.md § 5: Baseline Establishment](./EVALUATION_STRATEGY.md#4-baseline-establishment-strategy)

---

### Phase 3: Multi-Turn (Weeks 9-12)
**Goal**: Validate tool-use patterns and multi-turn orchestration.

**Deliverables**:
- TAU-bench 40%+ pass@1 (airline domain)
- Multi-turn stability (Pass@8 > 25%)
- Policy compliance (<5% violations)
- Dashboard + CI/CD (regression gate, nightly runs)

**Budget**: $240 (TAU-bench 50 tasks × 8 trials)

**Docs**:
- [BENCHMARK_INTEGRATION_GUIDE.md § 2: TAU-bench Integration](./BENCHMARK_INTEGRATION_GUIDE.md#2-tau-bench-integration)
- [EVALUATION_STRATEGY.md § 7: Implementation Roadmap](./EVALUATION_STRATEGY.md#7-implementation-roadmap)

---

## Related Documentation

### Internal Alef Documentation
- [README.md](../README.md) — Alef project overview
- [AGENTS.md](../AGENTS.md) — Development rules (conversational style, KISS, organ framework)
- [CONTRIBUTING.md](../CONTRIBUTING.md) — BDFL governance, fork-only contributions
- [packages/eval/SCOREBOARD.md](../packages/eval/SCOREBOARD.md) — Current evaluation results

### External Benchmark Documentation
- **SWE-bench**: https://www.swebench.com
- **TAU-bench**: https://taubench.com
- **WebVoyager**: https://github.com/MinorJerry/WebVoyager
- **OSWorld**: https://os-world.github.io

### Competitor Documentation
- **Claude Computer Use**: https://www.anthropic.com/news/3-5-models-and-computer-use
- **OpenAI Operator**: https://openai.com/index/introducing-operator
- **Gemini Agents**: https://cloud.google.com/gemini-enterprise-agent-platform

---

## Change Log

| Date | Author | Change |
|------|--------|--------|
| 2026-06-15 | dpopsuev | Initial evaluation strategy documents created |

---

## Feedback & Contributions

This is a **read-only fork** (BDFL governance). External contributions not accepted. However, feedback is welcome:

- **Issues**: File GitHub issue with [EVAL] prefix
- **Forks**: Fork and adapt for your own agent framework
- **Questions**: Discord community (see README)

For detailed governance: [CONTRIBUTING.md](../CONTRIBUTING.md)

---

## License

MIT (same as Alef project)

---

**Next Steps**:
1. Read [EVAL_ROADMAP_SUMMARY.md](./EVAL_ROADMAP_SUMMARY.md) (decision makers)
2. Review [BENCHMARK_INTEGRATION_GUIDE.md](./BENCHMARK_INTEGRATION_GUIDE.md) (engineers)
3. Start Phase 1 implementation (Week 1-2: Internal expansion)
4. Present baseline results (Week 4: Decision point for full SWE-bench run)
