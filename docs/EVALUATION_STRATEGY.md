# Alef Agent Evaluation Strategy

## Executive Summary

This document defines a comprehensive testing roadmap for Alef, identifying which benchmarks to run, what metrics to track, and how to establish baseline performance comparable to Claude Computer Use, Gemini agents, OpenAI Operator, and other frameworks.

**Current State**: Alef has an internal evaluation harness (`packages/eval`) with 12 custom evaluations focused on coding tasks (92% score, 100% pass rate on latest Claude Sonnet 4-5 run).

**Gap**: No standardized external benchmark coverage (SWE-bench, TAU-bench, WebVoyager, OSWorld) for apples-to-apples comparison with competing frameworks.

**Recommendation**: Implement a tiered evaluation strategy covering coding, tool use, web navigation, and computer control benchmarks while maintaining Alef's existing internal harness for regression detection.

---

## 1. Benchmark Landscape Analysis

### 1.1 SWE-bench Family (Software Engineering)

**What it measures**: Real-world GitHub issue resolution across Python repositories.

**Variants**:
- **SWE-bench Full** (2,294 tasks) — original dataset, high noise
- **SWE-bench Verified** (500 tasks) — curated subset, reduced false positives
- **SWE-bench Lite** (300 tasks) — easier subset for faster iteration
- **SWE-bench Pro** (public + held-out + commercial) — enterprise-level complexity, multi-file edits

**Current SOTA**:
- Claude Fable 5: 95% (Verified)
- GPT-5: 82.6% (Verified)
- Claude Sonnet 4.6: 79.6% (Verified)
- SWE-bench Pro: GPT-5 23.3%, Claude Opus 4.1 23.1% (public set)

**Evaluation Protocol**:
- Docker-based execution environment (already supported via `DockerSpace`)
- Pass criterion: patch resolves issue AND passes repository test suite
- Metrics: Pass@1, cost per task, time per task

**Relevance to Alef**: HIGH — Alef's core competency is coding. SWE-bench Verified is the industry standard for measuring coding agent capabilities.

**Implementation Effort**: Medium — Docker infrastructure exists, need SWE-bench dataset integration and test harness adapter.

---

### 1.2 TAU-bench (Tool-Agent-User Interaction)

**What it measures**: Multi-turn dialogues with simulated users in customer service domains (airline, retail, banking).

**Key Features**:
- Real-world APIs and databases
- Policy compliance requirements (agent must refuse invalid requests)
- User simulation via LLM
- Trajectory evaluation (did agent use correct tools?) + outcome evaluation (did task succeed?)

**Current SOTA**:
- o4-mini High: 56% (airline)
- Claude Opus 4.1: 52% (airline)
- GPT-5 Medium: 48% (airline)
- Gemini 3.5 Flash: ~45% (text mode)

**Evaluation Protocol**:
- Pass@k (k=8 for consistency check)
- Tool calling accuracy
- Policy adherence (did agent correctly refuse disallowed requests?)

**Relevance to Alef**: MEDIUM — TAU-bench emphasizes customer service domains. Alef is optimized for coding/development workflows, but tool-use patterns transfer.

**Implementation Effort**: High — requires user simulator integration, domain-specific APIs, and multi-turn conversation orchestration.

---

### 1.3 WebVoyager (Web Navigation)

**What it measures**: End-to-end web browsing tasks on real websites (Amazon, Google Flights, Apple, etc.).

**Current SOTA**:
- Browser Use: 89.1% (586 tasks)
- Browserable: 90.4% (567 tasks)
- OpenAI Operator: 68.6% (Emergence WebVoyager audit)
- OpenAI (reported): 87% (official claim, disputed)

**Evaluation Protocol**:
- 643 tasks across 15 popular websites (original dataset)
- Dual-mode evaluation: human annotation + GPT-4V automated scoring
- Success criterion: task completed correctly within step budget

**Known Issues**:
- Task drift (websites change, tasks become stale)
- Evaluation inconsistency (different teams exclude different tasks)
- Not reproducible (live websites, no deterministic scoring)

**Relevance to Alef**: LOW-MEDIUM — Alef's `organ-web` provides web fetch/search but not full browser control. Would require Playwright/Puppeteer integration for interactive tasks.

**Implementation Effort**: High — requires headless browser automation, screenshot/vision integration, task curation for updated websites.

---

### 1.4 OSWorld (Computer Use)

**What it measures**: Open-ended desktop tasks in real OS environments (Ubuntu, Windows, macOS) using mouse, keyboard, and application control.

**Dataset**: 369 tasks (361 excluding Google Drive manual setup) across Chrome, LibreOffice, VS Code, GIMP, Thunderbird.

**Current SOTA**:
- AGI Agent: 76.26% (superhuman vs 72.36% human baseline)
- Simular Agent S: 72.6%
- Claude Sonnet 4.6: 72.5%
- OpenAI CUA: 38.1% (full computer use)

**Evaluation Protocol**:
- Docker/VM-based execution environment
- Screenshot + a11y tree + terminal output as observations
- Execution-based success detection (files created, emails sent, etc.)

**Relevance to Alef**: MEDIUM — Alef has `organ-shell` for terminal control but no GUI/mouse automation. Computer use is adjacent to coding workflows (testing web UIs, debugging visual apps).

**Implementation Effort**: Very High — requires full computer use API (screenshot, mouse/keyboard events, window control), VM/container orchestration, multimodal observation handling.

---

### 1.5 Additional Benchmarks

**BrowseComp** (OpenAI): 1,266 hard-to-find information retrieval tasks. Measures research/browsing depth.

**GAIA** (Hugging Face): General AI assistant tasks requiring multi-step reasoning, tool use, and web search.

**Terminal-Bench**: Command-line interaction tasks. Relevant for `organ-shell` validation.

**AgentHarm**: Safety/jailbreak detection. Tests if agent overrides guardrails.

**ST-WebAgentBench** (IBM): High-risk business applications with safety/trust emphasis.

---

## 2. Recommended Benchmark Prioritization

### Tier 1: Core Competency Validation (Q1 2026)

**SWE-bench Verified** (500 tasks)
- Why: Industry standard for coding agents, direct competitor comparison
- Target: 60% pass@1 (competitive with Claude Sonnet 4.5)
- Cost estimate: ~$500-1000 (500 tasks × $1-2 per task with Claude Sonnet 4-5)
- Timeline: 2 weeks implementation + 1 week initial runs

**Internal Alef Eval Suite** (12 custom tasks)
- Why: Regression detection, fast feedback loop, no cost
- Target: 100% pass (all evaluations)
- Already implemented — expand to 50 tasks covering:
  - Multi-file refactoring
  - Test-driven development
  - Debugging
  - Documentation generation
  - Code review

### Tier 2: Tool Use & Multi-Turn (Q2 2026)

**TAU-bench** (airline domain, 50 tasks)
- Why: Multi-turn orchestration, tool calling accuracy, policy compliance
- Target: 40% pass@1 (competitive baseline)
- Cost estimate: ~$200-400
- Timeline: 3 weeks implementation

**Terminal-Bench**
- Why: Shell interaction validation (already partially implemented in eval)
- Target: 70% pass@1
- Cost estimate: minimal (existing `organ-shell` coverage)

### Tier 3: Exploration (Q3 2026)

**WebVoyager** (curated subset, 100 tasks)
- Why: Web research capabilities, competitive analysis
- Requires: Browser automation integration (Playwright)
- Target: 50% pass@1 (MVP)

**OSWorld** (Ubuntu subset, 50 tasks)
- Why: Computer use exploration, future-proofing
- Requires: Screenshot + mouse/keyboard API
- Target: 30% pass@1 (research mode)

---

## 3. Performance Metrics Framework

### 3.1 Primary Metrics

**Task Success Rate (Pass@1)**
- Binary: task fully resolved (1.0) or not (0.0)
- Report per benchmark and aggregate

**Task Success Distribution (Pass@k)**
- Run same task k times (k=5 for capability, k=1 for regression)
- Report pass@1, pass@3, pass@5
- Variance indicates stability/reliability

**Partial Credit Score**
- 0.0: hard fail (wrong files, broken code)
- 0.5: partial progress (correct structure, wrong logic)
- 1.0: full pass
- Only for internal evals (external benchmarks use binary pass/fail)

**Operational Agent Error (OAE)**
- Tool calls that fail / total tool calls
- Tracks wasted effort (hallucinated file paths, invalid arguments)

### 3.2 Cost Metrics

**Cost per Task**
- Input tokens × input cost + output tokens × output cost + cache × cache cost
- Report median, P90, P99

**Cost per Success**
- Total cost / number of successful tasks
- Compare against competitors (SWE-bench leaderboards report this)

**Token Efficiency**
- Tokens used / task complexity (proxy: lines of code changed)

### 3.3 Latency Metrics

**Wall Clock Time per Task**
- Start of first agent turn → task completion
- Report median, P90, P99

**Time per Turn**
- User message → agent response
- Track degradation over conversation length

**Tool Execution Overhead**
- Time spent in tool calls vs LLM inference
- Identify bottlenecks (slow file reads, shell commands)

### 3.4 Behavioral Metrics

**Tool Use Patterns**
- Which tools were called, how often, in what order
- Identify overuse (reads entire codebase) or underuse (skips verification)

**Turn Count Distribution**
- How many turns to solve task (or give up)
- Detect infinite loops, excessive back-and-forth

**Error Recovery Rate**
- Tasks that initially failed a tool call but recovered vs gave up
- Measures resilience

**Trajectory Efficiency**
- Did agent take shortest path (compare to reference solution)
- Identify planning inefficiencies

### 3.5 Quality Metrics

**Code Quality** (for SWE-bench)
- Does patch pass repository tests?
- Does patch introduce new linter errors?
- Is patch minimal (lines changed vs reference)?

**Policy Compliance** (for TAU-bench)
- Did agent correctly refuse invalid requests?
- Did agent expose sensitive data?

**Safety/Jailbreak Resistance** (for AgentHarm)
- Did agent execute harmful actions when instructed?

---

## 4. Baseline Establishment Strategy

### 4.1 Internal Baseline (Week 1-2)

1. **Run current eval suite** (12 tasks) with Claude Sonnet 4-5
   - Establish current performance (already done: 92% score, 100% pass)
   - Generate cost/latency profiles

2. **Expand to 50 tasks** covering:
   - Simple (1-file edits): 15 tasks
   - Medium (multi-file, <5 files): 20 tasks
   - Complex (repo-wide refactoring): 15 tasks

3. **Run with multiple models**:
   - Claude Sonnet 4-5 (current default)
   - Claude Opus 4-6 (high capability)
   - GPT-5 (competitor comparison)
   - Gemini 3 Pro (competitor comparison)

4. **Capture**:
   - Pass@1, pass@5
   - Cost per task
   - Time per task
   - OAE
   - Tool use patterns (fs.read vs lector.read, shell.exec frequency)

### 4.2 SWE-bench Verified Baseline (Week 3-5)

1. **Setup**:
   - Integrate SWE-bench harness (Docker-based evaluation)
   - Adapt Alef session → SWE-bench instance mapping
   - Configure timeout (10 min per task), cost cap ($5 per task)

2. **Initial Run** (50 tasks sample):
   - Stratified sample: easy/medium/hard
   - Run with Claude Sonnet 4-5
   - Measure pass@1, cost, time

3. **Full Run** (500 tasks):
   - Requires budget approval (~$1000)
   - Run overnight on CI infrastructure
   - Generate per-repo breakdown (which codebases does Alef handle well?)

4. **Competitor Comparison**:
   - Compare Alef (Claude Sonnet 4-5) vs published results:
     - SWE-agent (Claude Sonnet 4-5): 72.8%
     - Devin (unreported model): reported 70%+
     - OpenHands: ~50%
   - Identify gap: is it model quality, scaffolding, or tool design?

### 4.3 Cross-Framework Comparison (Week 6-8)

**Run same tasks with competing frameworks**:

1. **Claude Computer Use** (Anthropic):
   - Use official `computer-use-demo` scaffold
   - Run on OSWorld subset (if available)
   - Run on custom Alef eval tasks (if Computer Use supports file I/O)

2. **OpenAI Operator**:
   - Run on WebVoyager tasks
   - Run on BrowseComp (OpenAI's own benchmark)

3. **Gemini Agents** (Google Vertex AI):
   - Use Reasoning Engine + LangChain
   - Run on TAU-bench (tool use focus)
   - Run on SWE-bench (if Gemini supports function calling well)

**Metrics to compare**:
- Pass@1 (primary)
- Cost per task (critical for production viability)
- Time per task (user experience)
- Tool calling accuracy (did model use tools correctly?)
- Error recovery (did model handle failures gracefully?)

---

## 5. Evaluation Infrastructure Requirements

### 5.1 Harness Enhancements

**Current State**: `packages/eval` has:
- Custom evaluation definitions
- OTel span collection
- Deterministic checkers
- Fixture validation
- Scoreboard auto-generation

**Required Additions**:

1. **External Benchmark Adapters**:
   - `SWEBenchAdapter` — maps SWE-bench instances → Alef sessions
   - `TAUBenchAdapter` — integrates user simulator + domain APIs
   - `WebVoyagerAdapter` — drives Playwright/Puppeteer
   - `OSWorldAdapter` — connects to Docker/VM environments

2. **Pass@k Runner**:
   - Execute same task k times
   - Aggregate results (pass@1, pass@3, pass@5)
   - Detect variance (is agent consistent?)

3. **Cost Tracking**:
   - Integrate with `@dpopsuev/alef-ai` to capture token counts per request
   - Multiply by model pricing (input/output/cache rates)
   - Report per task and aggregate

4. **Parallel Execution**:
   - Run multiple tasks concurrently (limited by API rate limits)
   - Use work queue + worker pool pattern
   - Store results in `benchmark.jsonl` (already implemented)

5. **Leaderboard Integration**:
   - Auto-submit results to SWE-bench public leaderboard
   - Compare against published results from other frameworks

### 5.2 Observability

**OTel Tracing** (already implemented):
- Capture every tool call (span per tool execution)
- Track latency, success/failure, retry attempts
- Export to OTLP (OpenTelemetry Protocol) for Jaeger/Honeycomb

**Metrics to Track**:
- `alef.eval.task.duration` (histogram)
- `alef.eval.task.cost` (histogram)
- `alef.eval.task.turns` (histogram)
- `alef.eval.tool.calls` (counter, labeled by tool name)
- `alef.eval.tool.errors` (counter, labeled by tool + error type)

**Logs**:
- Session JSONL logs (already in `$XDG_DATA_HOME/alef/sessions/<cwd-hash>/`)
- Per-task debug logs (OTel spans + LLM request/response)
- Scoreboard markdown (auto-updated after each run)

### 5.3 CI/CD Integration

**Regression Suite** (runs on every PR):
- Internal Alef eval suite (12 tasks → 50 tasks)
- ToolLevel: ReadOnly + ReadWrite
- Temperature: 0 (deterministic)
- Pass criterion: 100% (all tasks must pass)
- Budget: ~$10 per PR

**Nightly Capability Suite**:
- SWE-bench Verified (500 tasks)
- Temperature: default (non-zero for exploration)
- Pass@5 (measure variance)
- Budget: ~$1000 per run

**Weekly Competitor Comparison**:
- Run same tasks with Claude Computer Use, Operator, Gemini
- Generate comparison report
- Track Alef's relative position on leaderboards

---

## 6. Comparison to Competitors

### 6.1 Claude Computer Use

**Strengths**:
- Native computer control (screenshot → action loop)
- OSWorld: 72.5% (Sonnet 4.6)
- Well-documented API

**Alef Differentiation**:
- Organ framework (modular, composable tools)
- File-system aware (lector symbol search, fs.edit diff-based edits)
- Development-focused (coding, debugging, testing workflows)
- Lower-level control (shell commands, direct file I/O)

**Comparison Strategy**:
- Run OSWorld tasks with both
- Compare on coding-specific tasks (SWE-bench)
- Measure cost/latency trade-offs

### 6.2 OpenAI Operator

**Strengths**:
- Web browsing focus (87% WebVoyager claimed, 68.6% independently measured)
- BrowseComp: strong performance on research tasks

**Weaknesses**:
- Web-only (no local file system access)
- Expensive ($200/month Pro subscription)
- Black box (no open scaffolding)

**Alef Differentiation**:
- Local-first (file system, shell, code analysis)
- Transparent (open source, inspectable traces)
- Cost-effective (pay-per-use API, no subscription)

**Comparison Strategy**:
- Run BrowseComp (if Alef implements `organ-web` browser control)
- Run coding tasks (Operator likely fails)
- Measure cost (Operator Pro vs Alef API costs)

### 6.3 Gemini Agents (Reasoning Engine)

**Strengths**:
- Trajectory evaluation (Google's Agent Eval Service)
- Native function calling
- TAU-bench competitive performance

**Weaknesses**:
- Vertex AI lock-in (requires Google Cloud)
- Limited tool library (no default file system tools)
- Less mature than Anthropic/OpenAI agents

**Alef Differentiation**:
- Model-agnostic (supports Anthropic, OpenAI, Google)
- Rich tool library (fs, shell, lector, web, memory, skills)
- Self-hostable (no cloud platform lock-in)

**Comparison Strategy**:
- Run TAU-bench with both (tool use focus)
- Run SWE-bench with both (coding tasks)
- Compare trajectory efficiency (turns to completion)

### 6.4 Summary Table

| Framework | Best Benchmarks | Strengths | Weaknesses | Alef Overlap |
|-----------|-----------------|-----------|------------|--------------|
| Claude Computer Use | OSWorld (72.5%) | Native computer control, screenshot API | Desktop-only, requires special API access | Medium (computer use is adjacent, not core) |
| OpenAI Operator | WebVoyager (87%*) | Web browsing, research tasks | Web-only, expensive, black box | Low (Alef is local-first) |
| Gemini Agents | TAU-bench (45%+) | Trajectory eval, function calling | Vertex lock-in, limited tools | Medium (tool use patterns transfer) |
| Alef | SWE-bench (TBD) | Coding focus, modular organs, open source | No computer use yet, no browser automation yet | N/A (this is us) |

*Disputed — independent audit found 68.6%

---

## 7. Implementation Roadmap

### Phase 1: Baseline (Weeks 1-4)

**Week 1-2: Internal Expansion**
- Expand eval suite from 12 → 50 tasks
- Add multi-file refactoring, debugging, test generation
- Run with Claude Sonnet 4-5, Opus 4-6, GPT-5
- Capture baseline: pass@1, cost, latency, OAE

**Week 3-4: SWE-bench Integration**
- Implement `SWEBenchAdapter`
- Run 50-task sample (stratified easy/medium/hard)
- Measure initial pass@1 (target: 40%+)
- Identify failure modes (tool errors? planning? verification?)

**Deliverable**: Baseline report comparing Alef across models and vs SWE-bench leaderboard.

### Phase 2: Optimization (Weeks 5-8)

**Week 5-6: Tool Refinement**
- Analyze OTel traces from SWE-bench runs
- Identify tool use inefficiencies (e.g., does Alef read too many files?)
- Optimize `organ-fs`, `organ-lector`, `organ-shell`
- Add missing tools (e.g., `git.apply-patch`, `test.run`)

**Week 7-8: Scaffolding Improvements**
- Improve planning (does Alef outline before coding?)
- Add verification loops (does Alef test changes before submitting?)
- Tune system prompts (reduce hallucination, increase precision)

**Deliverable**: +10-20% improvement on SWE-bench Verified (target: 60% pass@1).

### Phase 3: Multi-Turn & Tool Use (Weeks 9-12)

**Week 9-10: TAU-bench Integration**
- Implement user simulator
- Integrate airline domain APIs
- Run 50-task subset
- Measure tool calling accuracy + policy compliance

**Week 11-12: Terminal-Bench**
- Expand shell evaluation coverage
- Add error recovery tests
- Measure command correctness

**Deliverable**: TAU-bench 40% pass@1, Terminal-Bench 70% pass@1.

### Phase 4: Exploration (Weeks 13-16)

**Week 13-14: WebVoyager (if browser automation added)**
- Integrate Playwright
- Implement `organ-browser` (screenshot, click, type actions)
- Run 100-task subset
- Measure web navigation success

**Week 15-16: OSWorld (if computer use added)**
- Implement screenshot → action API
- Run Ubuntu subset (50 tasks)
- Measure desktop automation success

**Deliverable**: Research report on Alef's computer use potential.

---

## 8. Success Criteria

### Phase 1 (Baseline) — Complete by Week 4
- [ ] 50-task internal eval suite (100% pass with Claude Sonnet 4-5)
- [ ] SWE-bench Verified integration (harness runs end-to-end)
- [ ] Initial SWE-bench score (40%+ pass@1)
- [ ] Baseline report (Alef vs leaderboard)

### Phase 2 (Optimization) — Complete by Week 8
- [ ] SWE-bench Verified 60%+ pass@1 (competitive with mid-tier agents)
- [ ] Cost per task < $2 (competitive with SWE-agent)
- [ ] OAE < 5% (tool calls rarely fail)

### Phase 3 (Multi-Turn) — Complete by Week 12
- [ ] TAU-bench 40%+ pass@1 (airline domain)
- [ ] Terminal-Bench 70%+ pass@1
- [ ] Multi-turn conversation evaluation (3+ turns, maintains context)

### Phase 4 (Exploration) — Complete by Week 16
- [ ] WebVoyager 50%+ pass@1 (if browser automation implemented)
- [ ] OSWorld 30%+ pass@1 (if computer use implemented)
- [ ] Public leaderboard submission (SWE-bench, TAU-bench)

---

## 9. Open Questions & Risks

### Technical Risks

**SWE-bench Gaming Concerns**:
- Recent research shows SWE-bench can be gamed (agent exploits test harness)
- Mitigation: Use SWE-bench Verified (curated, high-quality tasks) + manual spot checks

**Benchmark Reproducibility**:
- WebVoyager tasks drift (websites change)
- OSWorld requires VM orchestration (slow, expensive)
- Mitigation: Focus on SWE-bench (stable, Docker-based) and internal evals

**Cost Overruns**:
- Full SWE-bench run costs $500-1000
- TAU-bench requires multiple trials (pass@8 for stability)
- Mitigation: Start with subsets, run full suite only after optimization

### Strategic Risks

**Alef's Positioning**:
- Is Alef a coding agent (compete on SWE-bench) or general assistant (compete on TAU/OSWorld)?
- Decision: Focus on coding first (core competency), explore general assistance later

**Benchmark Selection Bias**:
- Choosing benchmarks where Alef naturally excels (file I/O, coding) vs stretching into weak areas (web browsing)
- Decision: Prioritize coding benchmarks (SWE-bench) but include TAU-bench for tool-use validation

**Leaderboard Obsession**:
- Risk of over-optimizing for benchmarks (teaching to the test)
- Mitigation: Maintain internal eval suite (captures real user workflows), use benchmarks for calibration only

---

## 10. Recommendations

### Immediate Actions (Next 2 Weeks)

1. **Expand internal eval suite** from 12 → 50 tasks (coding-focused)
2. **Run baseline with 3 models** (Claude Sonnet 4-5, Opus 4-6, GPT-5)
3. **Integrate SWE-bench harness** (Docker execution, 50-task sample)
4. **Capture metrics** (pass@1, cost, latency, OAE, tool use patterns)

### Medium-Term Goals (Weeks 3-8)

1. **Achieve SWE-bench Verified 60%+ pass@1** (competitive baseline)
2. **Reduce cost per task** to <$2 (match or beat SWE-agent)
3. **Optimize tool use** (reduce OAE to <5%)
4. **Submit to SWE-bench leaderboard** (public validation)

### Long-Term Goals (Weeks 9-16)

1. **Add TAU-bench coverage** (tool-use validation, 40%+ pass@1)
2. **Explore computer use** (OSWorld subset, research mode)
3. **Publish comparison report** (Alef vs Claude Computer Use, Operator, Gemini)
4. **Open source evaluation harness** (community contributions to benchmark coverage)

### Non-Goals

- **Do not** implement full WebVoyager until `organ-browser` (Playwright integration) is ready
- **Do not** chase OSWorld leaderboard (computer use is exploratory, not core competency)
- **Do not** optimize solely for benchmarks (maintain real-world eval tasks)

---

## 11. Metrics Dashboard Specification

### Landing Page Metrics

**Overall Performance**:
- Pass@1 (aggregate across all benchmarks)
- Cost per task (median)
- Time per task (median)

**Benchmark Breakdown**:
- SWE-bench Verified: X% (target: 60%)
- TAU-bench: X% (target: 40%)
- Internal Eval: X% (target: 100%)

**Trend Over Time**:
- Weekly scorecard (are we improving?)
- Cost trend (are we getting cheaper?)
- Latency trend (are we getting faster?)

### Per-Benchmark Dashboards

**SWE-bench Verified**:
- Pass@1 by repository (which codebases does Alef handle well?)
- Pass@1 by difficulty (easy/medium/hard)
- Cost distribution (histogram)
- Time distribution (histogram)
- Tool use patterns (fs.read vs lector.read frequency)

**TAU-bench**:
- Pass@1 by domain (airline, retail, banking)
- Policy compliance rate
- Tool calling accuracy
- Turn count distribution

**Internal Eval**:
- Pass@1 by template (ReadOnly, Write, MultiTurn)
- Score distribution (0.0, 0.5, 1.0)
- Fixture validation status (all checkers must pass on known-good code)

### Comparison View

**Alef vs Competitors** (side-by-side):
- SWE-bench: Alef (X%) vs SWE-agent (72.8%) vs Devin (70%)
- TAU-bench: Alef (X%) vs Claude Opus 4.1 (52%) vs GPT-5 (48%)
- Cost: Alef ($X/task) vs SWE-agent ($Y/task)

---

## 12. Conclusion

Alef has a strong foundation (internal eval harness, modular organ framework, multi-provider LLM support) but lacks external benchmark coverage for competitive comparison.

**Recommended priorities**:
1. **SWE-bench Verified** (industry standard for coding agents)
2. **Internal eval expansion** (50 tasks, regression protection)
3. **TAU-bench** (tool-use validation, multi-turn orchestration)

**Success looks like**:
- 60%+ pass@1 on SWE-bench Verified (competitive with mid-tier agents)
- <$2 cost per task (production-viable)
- 100% pass on internal evals (no regressions)
- Public leaderboard presence (credibility with users/investors)

**Next step**: Run baseline (Week 1-2) and present findings to decide on budget allocation for full SWE-bench runs.
