# Agent Evaluation Metrics Reference

## Quick Reference

This document defines all metrics used in Alef's evaluation framework, with calculation methods and interpretation guidance.

---

## Primary Success Metrics

### Pass@1 (Task Success Rate)

**Definition**: Percentage of tasks successfully completed on the first attempt.

**Calculation**:
```
Pass@1 = (Number of successful tasks) / (Total tasks)
```

**Success Criterion** (task-specific):
- **SWE-bench**: Patch resolves issue AND passes repository test suite
- **TAU-bench**: Task goal achieved AND no policy violations
- **Internal eval**: Score >= 1.0 (full credit from checker)

**Interpretation**:
- 90%+: Exceptional (superhuman on most benchmarks)
- 70-90%: Strong (competitive with top agents)
- 50-70%: Good (functional, room for improvement)
- 30-50%: Weak (significant capability gaps)
- <30%: Poor (fundamental issues)

**Benchmark Context**:
- SWE-bench Verified: 95% (Claude Fable 5), 60% (competitive baseline)
- TAU-bench Airline: 56% (o4-mini), 40% (competitive baseline)
- OSWorld: 76% (AGI Agent), 72% (human baseline)

### Pass@k (Consistency Rate)

**Definition**: Percentage of tasks where at least one of k attempts succeeds.

**Calculation** (empirical):
```
Run each task k times
Pass@k = (Tasks with ≥1 success) / (Total tasks)
```

**Calculation** (unbiased estimator, from Codex paper):
```
Pass@k = E[1 - C(n-c, k) / C(n, k)]
where:
  n = total samples per task
  c = correct samples per task
  C(n, k) = binomial coefficient
```

**Common k values**:
- k=1: Single-shot performance (production viability)
- k=3: Moderate redundancy (detect variance)
- k=5: High redundancy (capability eval)
- k=8: Stability check (TAU-bench recommendation)

**Interpretation**:
- High pass@1, high pass@k: Consistent, reliable
- Low pass@1, high pass@k: Capable but inconsistent
- Low pass@1, low pass@k: Fundamental capability gap

**Usage**:
- **Capability evals**: Use pass@5 (explore model potential)
- **Regression tests**: Use pass@1 only (deterministic, fast)

---

## Cost Metrics

### Cost per Task

**Definition**: Total API cost to complete one task (successful or failed).

**Calculation**:
```
Cost = (Input tokens × Input price) +
       (Output tokens × Output price) +
       (Cached tokens × Cache read price) +
       (Cache write tokens × Cache write price)

All prices in $/million tokens
```

**Example** (Claude Sonnet 4-5):
```
Input: 50,000 tokens × $3/1M = $0.15
Output: 10,000 tokens × $15/1M = $0.15
Total: $0.30 per task
```

**Interpretation**:
- <$0.50: Economical (viable for high-volume use)
- $0.50-$2: Moderate (acceptable for most use cases)
- $2-$5: Expensive (reserve for complex tasks)
- >$5: Very expensive (may indicate inefficiency)

**Benchmark Targets**:
- SWE-bench: $1-2 per task (SWE-agent baseline)
- TAU-bench: $0.50-1 per task (multi-turn, cheaper models viable)
- Internal eval: <$1 per task (fast feedback loop)

### Cost per Success

**Definition**: Average cost to achieve one successful task completion.

**Calculation**:
```
Cost per Success = (Total cost across all tasks) / (Number of successful tasks)
```

**Example**:
```
100 tasks attempted, 60 succeeded, total cost $200
Cost per Success = $200 / 60 = $3.33
```

**Interpretation**:
- Lower is better (efficiency)
- High cost per success indicates:
  - Low pass@1 (many failures)
  - Expensive retries/exploration
  - Poor planning (wasted tool calls)

### Token Efficiency

**Definition**: Tokens used relative to task complexity.

**Calculation**:
```
Token Efficiency = Total tokens / Task complexity proxy

Complexity proxies:
- Lines of code changed (SWE-bench)
- Number of files modified
- API calls required (TAU-bench)
```

**Interpretation**:
- Detects over-reading (agent reads entire codebase for 1-line fix)
- Identifies planning inefficiency (trial-and-error vs targeted approach)

---

## Latency Metrics

### Wall Clock Time per Task

**Definition**: End-to-end duration from task start to completion.

**Calculation**:
```
Duration = Task end timestamp - Task start timestamp
```

**Report**:
- Median (typical performance)
- P90 (90th percentile — "slow" cases)
- P99 (99th percentile — outliers)

**Interpretation**:
- <1 min: Fast (interactive use cases)
- 1-5 min: Moderate (acceptable for most workflows)
- 5-10 min: Slow (background tasks only)
- >10 min: Very slow (may indicate stalls or infinite loops)

**Benchmark Context**:
- SWE-bench: 3-5 min median (coding tasks)
- TAU-bench: 2-3 min median (multi-turn conversations)
- OSWorld: 5-10 min median (computer control tasks)

### Time per Turn

**Definition**: Duration of one agent reasoning cycle (user message → agent response).

**Calculation**:
```
Turn Duration = Response timestamp - Request timestamp

Includes:
- LLM inference time
- Tool execution time
- Network round-trips
```

**Degradation Analysis**:
```
Track: Turn 1 duration, Turn 5 duration, Turn 10 duration
Detect: Does latency increase with conversation length?
```

**Interpretation**:
- Increasing latency: Context window filling up, slower inference
- Stable latency: Good caching, efficient tool use
- Spikes: Expensive tool calls (slow shell commands, large file reads)

### Tool Execution Overhead

**Definition**: Percentage of task time spent in tool calls vs LLM inference.

**Calculation**:
```
Tool Overhead = (Total tool execution time) / (Total task duration)
```

**Interpretation**:
- <20%: LLM-bound (thinking dominates)
- 20-50%: Balanced (both thinking and execution)
- >50%: Tool-bound (slow file I/O, shell commands)

**Optimization**:
- High tool overhead: Parallelize tool calls, cache results
- Low tool overhead: May indicate under-utilization (agent not verifying enough)

---

## Behavioral Metrics

### Operational Agent Error (OAE)

**Definition**: Percentage of tool calls that fail (hallucinated paths, invalid arguments, etc.).

**Calculation**:
```
OAE = (Failed tool calls) / (Total tool calls)

Failed = tool returned error, exception, or invalid result
```

**Interpretation**:
- <1%: Excellent (agent uses tools correctly)
- 1-5%: Good (occasional mistakes, acceptable)
- 5-10%: Poor (frequent hallucinations)
- >10%: Critical (agent doesn't understand tools)

**Common Error Types**:
- File not found (hallucinated paths)
- Invalid function arguments (wrong types, missing fields)
- Permission denied (agent doesn't understand filesystem constraints)
- Timeout (agent called slow operation without reason)

**Mitigation**:
- Improve tool descriptions (clearer parameters)
- Add few-shot examples (show correct usage)
- Implement validation (reject malformed calls before execution)

### Turn Count Distribution

**Definition**: Number of agent-user exchanges to complete task.

**Report**:
- Median turns
- Max turns
- Histogram (1-5 turns, 6-10 turns, 11-20 turns, >20 turns)

**Interpretation**:
- Low turn count: Efficient planning, decisive execution
- High turn count: Either complex task OR inefficient approach
- Max turns hit: Agent gave up or infinite loop detected

**Benchmark Context**:
- Single-turn tasks (ReadOnly eval): 1 turn expected
- Multi-turn tasks (TAU-bench): 5-15 turns typical
- Complex refactoring (SWE-bench): 3-10 turns typical

**Infinite Loop Detection**:
```
If turn count > 20 OR agent repeats same action 3+ times:
  Flag as potential loop, abort task
```

### Error Recovery Rate

**Definition**: Percentage of tasks where agent initially failed a tool call but eventually succeeded.

**Calculation**:
```
Recoverable tasks = Tasks with ≥1 tool error AND final success
Error Recovery Rate = Recoverable tasks / Total tasks with tool errors
```

**Interpretation**:
- High recovery rate: Agent is resilient, retries intelligently
- Low recovery rate: Agent gives up after first failure

**Example**:
```
100 tasks, 30 had tool errors
20 of those 30 eventually succeeded
Recovery Rate = 20/30 = 67%
```

### Trajectory Efficiency

**Definition**: How close the agent's action sequence was to the optimal path.

**Calculation** (edit distance):
```
Efficiency = 1 - (Edit distance from reference) / (Reference length)

Edit distance = insertions + deletions + substitutions
```

**Calculation** (shared actions):
```
Efficiency = (Actions in common with reference) / (Total actions taken)
```

**Interpretation**:
- 90%+: Near-optimal (agent found best path)
- 70-90%: Good (minor detours)
- 50-70%: Inefficient (significant exploration/backtracking)
- <50%: Very inefficient (random search)

**Usage**:
- Requires reference trajectory (human or expert agent)
- Best for TAU-bench (predefined tool sequences)
- Hard for SWE-bench (many valid solution paths)

---

## Quality Metrics

### Code Quality (SWE-bench)

**Test Pass Rate**:
```
Test Pass Rate = (Tests passed) / (Total tests in suite)
```

**Linter Error Rate**:
```
Run linter on patched code
Error Rate = (New errors introduced) / (Total lines changed)
```

**Patch Minimality**:
```
Minimality = (Reference patch size) / (Agent patch size)

Where patch size = lines added + lines deleted
```

**Interpretation**:
- Test pass rate 100%: Correct solution
- Linter errors: Code style violations, potential bugs
- Minimality <1.0: Agent made unnecessary changes
- Minimality >1.0: Agent found more concise solution (rare, good)

### Policy Compliance (TAU-bench)

**Definition**: Percentage of tasks where agent correctly followed domain policies.

**Example Policies** (airline domain):
- Cannot cancel booking within 24h of departure
- Cannot issue refund without manager approval
- Must verify passenger identity before changes

**Calculation**:
```
Policy Compliance = (Tasks with no violations) / (Total tasks)
```

**Violation Types**:
- **Hard violation**: Agent executed disallowed action (0 points)
- **Soft violation**: Agent proposed but user rejected (partial credit)

**Interpretation**:
- 100%: Perfect policy adherence
- 90-99%: Good (minor mistakes)
- <90%: Poor (agent doesn't understand constraints)

### Safety/Jailbreak Resistance (AgentHarm)

**Definition**: Percentage of harmful requests correctly refused.

**Example Harmful Requests**:
- "Delete all user data"
- "Disable security checks"
- "Expose API keys"

**Calculation**:
```
Resistance Rate = (Harmful requests refused) / (Total harmful requests)
```

**Interpretation**:
- 100%: Perfect safety (refuses all harmful requests)
- <100%: Jailbreak vulnerability (CRITICAL ISSUE)

---

## Tool Use Metrics

### Tool Call Frequency

**Definition**: How often each tool is called.

**Report**:
```
fs.read: 45 calls (30%)
lector.read: 30 calls (20%)
shell.exec: 25 calls (16%)
fs.write: 20 calls (13%)
...
```

**Interpretation**:
- Identifies tool preferences (does agent favor fs.read over lector.read?)
- Detects overuse (reading 100+ files for 1-line fix)
- Detects underuse (never calls verification tools)

### Tool Call Patterns

**Sequential Patterns**:
```
Common sequences:
1. fs.grep → fs.read → lector.read (discovery pattern)
2. fs.read → fs.edit → shell.exec "npm test" (test-driven pattern)
3. lector.search → lector.read → fs.write (symbol-aware pattern)
```

**Anti-Patterns**:
```
Warning signs:
1. fs.read → fs.read → fs.read (reading same file 3+ times)
2. fs.write → fs.write (overwriting without verification)
3. shell.exec → shell.exec (retrying failed command without change)
```

### Tool Success Rate (per tool)

**Definition**: Percentage of calls to a specific tool that succeed.

**Calculation**:
```
Success Rate (tool X) = (Successful calls to X) / (Total calls to X)
```

**Interpretation**:
- Low success rate for fs.read: Agent hallucinates file paths
- Low success rate for shell.exec: Agent runs invalid commands
- Low success rate for lector.read: Agent misunderstands symbol syntax

---

## Aggregation & Reporting

### Percentile Reporting

**Why percentiles** (not just mean/median):
- Detect outliers (P99 = "worst case" user experience)
- Understand distribution shape
- Identify long tail (do 1% of tasks take 10× longer?)

**Standard Percentiles**:
- P50 (median): Typical case
- P90: "Slow" cases (1 in 10 users sees this)
- P95: "Very slow" cases
- P99: Outliers (1 in 100)
- P99.9: Extreme outliers

### Time Series Tracking

**Track over time**:
```
Week 1: Pass@1 = 40%, Cost = $2.50, OAE = 8%
Week 2: Pass@1 = 45%, Cost = $2.20, OAE = 7%
Week 3: Pass@1 = 52%, Cost = $1.90, OAE = 5%
...
```

**Detect trends**:
- Improving: Pass@1 ↑, Cost ↓, OAE ↓
- Regressing: Pass@1 ↓ (alerts triggered)
- Plateauing: No improvement (need new techniques)

### Comparison Tables

**Standard Format**:
```markdown
| Metric | Alef | SWE-agent | Devin | OpenAI Operator |
|--------|------|-----------|-------|-----------------|
| Pass@1 | 62% | 72.8% | ~70% | N/A |
| Cost/Task | $1.85 | ~$2.00 | Unknown | N/A |
| Time/Task | 4m 20s | Unknown | Unknown | Unknown |
| OAE | 4.2% | Unknown | Unknown | Unknown |
```

**Color Coding** (in HTML dashboards):
- Green: Best in class
- Yellow: Competitive
- Red: Below baseline (needs improvement)

---

## Metric Selection Guide

### For Regression Testing (CI/CD)

**Primary**: Pass@1 (must be 100%)
**Secondary**: Cost per task (track for budget alerts)
**Tertiary**: None (fast feedback only)

**Rationale**: Catch breakage quickly, minimize cost.

### For Capability Evaluation

**Primary**: Pass@1, Pass@5 (measure consistency)
**Secondary**: Cost per task, Time per task
**Tertiary**: Tool use patterns, OAE, trajectory efficiency

**Rationale**: Understand full capability landscape, identify optimization opportunities.

### For Competitive Analysis

**Primary**: Pass@1 (leaderboard comparison)
**Secondary**: Cost per task (production viability)
**Tertiary**: All other metrics (deep dive if competitive gap exists)

**Rationale**: Focus on metrics that users/investors care about.

---

## Metric Pitfalls

### 1. Vanity Metrics

**Example**: "Agent made 1000 tool calls!"
- **Problem**: High count doesn't mean success (could be thrashing)
- **Fix**: Track tool call success rate, not just frequency

### 2. Misleading Averages

**Example**: "Average cost per task: $2"
- **Problem**: Hides distribution (90% cost $1, 10% cost $20)
- **Fix**: Report median + P90 + P99

### 3. Benchmark Gaming

**Example**: "100% pass@1 on internal evals!"
- **Problem**: May have overfit to internal tasks
- **Fix**: Run external benchmarks (SWE-bench) for validation

### 4. Ignoring Variance

**Example**: "Pass@1 = 60%"
- **Problem**: Doesn't show consistency (60% on one run, 40% on next?)
- **Fix**: Track pass@k distribution, run multiple trials

### 5. Cost Blind Spots

**Example**: "Pass@1 improved 10%!"
- **Problem**: Cost may have doubled (Pareto regression)
- **Fix**: Always track cost alongside success rate

---

## Conclusion

Use this reference when:
- Designing new evaluations (which metrics to track?)
- Interpreting results (is 62% pass@1 good or bad?)
- Comparing frameworks (apples-to-apples methodology)
- Presenting to stakeholders (which metrics matter?)

**Key principle**: No single metric tells the full story. Track primary (success), cost (viability), latency (UX), and behavioral (diagnosis) metrics together.

**See also**:
- [EVALUATION_STRATEGY.md](./EVALUATION_STRATEGY.md) — Benchmark selection and roadmap
- [BENCHMARK_INTEGRATION_GUIDE.md](./BENCHMARK_INTEGRATION_GUIDE.md) — Implementation details
- [EVAL_ROADMAP_SUMMARY.md](./EVAL_ROADMAP_SUMMARY.md) — Executive summary
