# Benchmark Integration Implementation Guide

## Overview

This document provides technical specifications for integrating external benchmarks (SWE-bench, TAU-bench, WebVoyager, OSWorld) into Alef's existing evaluation harness.

**Target**: `packages/eval` — extend current evaluation framework while preserving existing internal eval capabilities.

---

## 1. SWE-bench Integration

### 1.1 Architecture

```
SWEBenchAdapter
  ↓
Alef Session (with ToolShell + LlmPipeline + DelegateOrgan)
  ↓
DockerSpace (isolated execution environment)
  ↓
SWE-bench Evaluation Harness (test runner)
  ↓
Result Collection (pass/fail + cost + traces)
```

### 1.2 Implementation Plan

**Step 1: Dataset Integration**

```typescript
// packages/eval/src/evaluations/swe-bench.ts

import type { Evaluation } from "../evaluation.js";

export interface SWEBenchInstance {
  instance_id: string;           // "django__django-11630"
  repo: string;                  // "django/django"
  base_commit: string;           // "abc123..."
  problem_statement: string;     // GitHub issue text
  hints_text: string;            // Optional hints
  test_patch: string;            // Tests that must pass
  version: string;               // Python version
  environment_setup_commit: string;
}

export interface SWEBenchEvaluation extends Evaluation {
  instance: SWEBenchInstance;
  dockerImage: string;           // Pre-built image with repo at base_commit
  timeout: number;               // 10 minutes default
  costCap: number;               // $5 default
}

// Load SWE-bench Verified dataset (500 instances)
export async function loadSWEBenchVerified(): Promise<SWEBenchEvaluation[]> {
  // Fetch from https://github.com/swe-bench/SWE-bench/tree/main/data
  // Parse instances and convert to Alef evaluation format
}
```

**Step 2: Docker Environment Setup**

```typescript
// packages/eval/src/swe-bench-space.ts

import { DockerSpace } from "@dpopsuev/alef-organ-enclosure";

export async function createSWEBenchSpace(
  instance: SWEBenchInstance,
): Promise<DockerSpace> {
  // Use pre-built SWE-bench Docker images (one per repo)
  const image = `swebench/${instance.repo.replace("/", "__")}:${instance.base_commit}`;
  
  return DockerSpace.create({
    image,
    workspace: "/testbed",  // SWE-bench convention
    env: {
      PYTHONPATH: "/testbed",
    },
    memory: 4,  // GB (SWE-bench tasks can be memory-intensive)
    cpu: 2,
    startupTimeoutMs: 120_000,
  });
}
```

**Step 3: Evaluation Runner**

```typescript
// packages/eval/src/evaluations/swe-bench-runner.ts

import type { RunMetrics } from "../metrics.js";
import { createCodingAgent } from "@dpopsuev/alef-coding-agent/testkit";

export async function runSWEBenchInstance(
  instance: SWEBenchInstance,
  model: Model<Api>,
): Promise<RunMetrics> {
  const space = await createSWEBenchSpace(instance);
  const agent = createCodingAgent({
    cwd: space.workDir(),
    model,
    organs: ["fs", "shell", "lector", "delegate", "skills"],
  });

  const prompt = formatSWEBenchPrompt(instance);
  
  try {
    const result = await agent.run({
      text: prompt,
      timeout: instance.timeout,
      costCap: instance.costCap,
    });

    // Verify solution: apply patch and run tests
    const patch = extractPatchFromResult(result);
    await space.exec(`git apply patch.diff`);
    
    const testResult = await runSWEBenchTests(space, instance);
    
    return {
      instanceId: instance.instance_id,
      success: testResult.passed,
      score: testResult.passed ? 1.0 : 0.0,
      cost: result.totalCost,
      duration: result.duration,
      turns: result.turns,
      traces: result.otelSpans,
    };
  } finally {
    await space.destroy();
  }
}

function formatSWEBenchPrompt(instance: SWEBenchInstance): string {
  return `
You are a software engineer working on the ${instance.repo} repository.

**Issue**: ${instance.problem_statement}

${instance.hints_text ? `**Hints**: ${instance.hints_text}` : ""}

Please resolve this issue by:
1. Reading relevant code files
2. Understanding the bug or feature request
3. Writing a patch that fixes the issue
4. Verifying your changes pass the repository's test suite

Submit your final patch when ready.
`.trim();
}
```

**Step 4: Test Execution**

```typescript
// packages/eval/src/swe-bench-tests.ts

export async function runSWEBenchTests(
  space: DockerSpace,
  instance: SWEBenchInstance,
): Promise<{ passed: boolean; output: string }> {
  // Apply test patch (fail-to-pass tests)
  await space.exec(`git apply test.patch`);
  
  // Run pytest with fail-to-pass tests only
  const result = await space.exec(
    `pytest -xvs ${instance.test_directives}`,
    { timeout: 300_000 }, // 5 minutes
  );
  
  return {
    passed: result.exitCode === 0,
    output: result.output,
  };
}
```

**Step 5: Leaderboard Submission**

```typescript
// packages/eval/src/swe-bench-submit.ts

export async function submitToSWEBenchLeaderboard(
  results: RunMetrics[],
  modelName: string,
) {
  // Format results per SWE-bench submission schema
  const predictions = results.map(r => ({
    instance_id: r.instanceId,
    model_patch: r.patch,
    model_name_or_path: modelName,
  }));

  // Write to JSON file for manual submission
  // (SWE-bench leaderboard requires GitHub PR submission)
  await writeFile(
    "swe_bench_predictions.json",
    JSON.stringify(predictions, null, 2),
  );
}
```

### 1.3 Cost Estimates

**SWE-bench Verified (500 tasks)**:
- Model: Claude Sonnet 4-5
- Estimated tokens per task: 50k input + 10k output (based on median codebase size)
- Cost: (50k × $3/1M) + (10k × $15/1M) = $0.15 + $0.15 = $0.30 per task
- Total: 500 × $0.30 = **$150 minimum**
- With retries/exploration: **$500-1000 realistic**

**Cost Cap Strategy**:
- Set per-task cap: $5 (prevents runaway costs)
- Abort tasks exceeding cap (mark as failed)
- Track tasks that hit cap (identify optimization targets)

### 1.4 Metrics to Capture

```typescript
export interface SWEBenchMetrics extends RunMetrics {
  repo: string;
  difficulty: "easy" | "medium" | "hard";  // Inferred from test count
  patchSize: number;                       // Lines changed
  testsPassed: number;
  testsFailed: number;
  linterErrors: number;                    // Did patch introduce new issues?
  toolCalls: ToolCallMetrics;
}

export interface ToolCallMetrics {
  fsRead: number;
  lectorRead: number;
  shellExec: number;
  fsWrite: number;
  fsEdit: number;
  totalDuration: number;  // Time spent in tools vs LLM
}
```

---

## 2. TAU-bench Integration

### 2.1 Architecture

```
TAUBenchAdapter
  ↓
User Simulator (LLM-based customer)
  ↓
Alef Agent (with tools for airline/retail/banking APIs)
  ↓
Multi-turn conversation (up to 20 turns)
  ↓
Trajectory Checker (did agent use correct tools?)
  ↓
Outcome Checker (did task succeed?)
```

### 2.2 Implementation Plan

**Step 1: User Simulator**

```typescript
// packages/eval/src/tau-bench/user-simulator.ts

export class UserSimulator {
  constructor(
    private readonly task: TAUBenchTask,
    private readonly model: Model<Api>,
  ) {}

  async generateNextMessage(conversationHistory: Message[]): Promise<string> {
    // User simulator is given:
    // - Task goal (e.g., "Change flight to tomorrow")
    // - Conversation so far
    // - Whether task is complete
    
    const prompt = `
You are a customer in an ${this.task.domain} customer service scenario.

**Goal**: ${this.task.userGoal}
**Current conversation**: ${formatHistory(conversationHistory)}

Generate the next customer message. Be realistic:
- Ask for help if confused
- Provide information when agent requests it
- Confirm understanding
- Indicate when satisfied

If the task is complete, say "Thank you, that's all I needed."
`.trim();

    return await this.model.generate(prompt);
  }

  isTaskComplete(conversationHistory: Message[]): boolean {
    // Heuristic: customer says "thank you" or equivalent
    const lastMessage = conversationHistory[conversationHistory.length - 1];
    return /thank you|that'?s all|perfect|sounds good/i.test(lastMessage.text);
  }
}
```

**Step 2: Domain API Integration**

```typescript
// packages/eval/src/tau-bench/airline-api.ts

export class AirlineAPI {
  constructor(private readonly database: AirlineDatabase) {}

  async searchFlights(from: string, to: string, date: string): Promise<Flight[]> {
    return this.database.flights.filter(f =>
      f.origin === from && f.destination === to && f.date === date
    );
  }

  async bookFlight(flightId: string, passengerId: string): Promise<Booking> {
    const flight = this.database.flights.get(flightId);
    if (!flight || flight.availableSeats === 0) {
      throw new Error("Flight not available");
    }
    
    const booking = {
      id: generateId(),
      flightId,
      passengerId,
      status: "confirmed",
    };
    
    this.database.bookings.set(booking.id, booking);
    flight.availableSeats--;
    
    return booking;
  }

  async cancelBooking(bookingId: string): Promise<void> {
    const booking = this.database.bookings.get(bookingId);
    if (!booking) {
      throw new Error("Booking not found");
    }
    
    // Policy check: cancellation must be >24h before flight
    const flight = this.database.flights.get(booking.flightId);
    const hoursUntilFlight = (flight.departureTime - Date.now()) / 3600000;
    
    if (hoursUntilFlight < 24) {
      throw new Error("Cannot cancel within 24 hours of departure");
    }
    
    booking.status = "cancelled";
    flight.availableSeats++;
  }
}
```

**Step 3: Agent Tools**

```typescript
// packages/eval/src/tau-bench/airline-organ.ts

import { defineOrgan, typedAction } from "@dpopsuev/alef-kernel";
import { z } from "zod";

export function createAirlineOrgan(api: AirlineAPI) {
  return defineOrgan("airline", {
    "motor/airline.search-flights": typedAction(
      {
        name: "airline.search-flights",
        description: "Search for available flights",
        parameters: z.object({
          from: z.string().describe("Origin airport code"),
          to: z.string().describe("Destination airport code"),
          date: z.string().describe("Date in YYYY-MM-DD format"),
        }),
      },
      async (ctx) => {
        const flights = await api.searchFlights(
          ctx.input.from,
          ctx.input.to,
          ctx.input.date,
        );
        
        return withDisplay(
          { flights },
          { text: formatFlights(flights), mimeType: "text/plain" },
        );
      },
    ),
    
    "motor/airline.book-flight": typedAction(
      {
        name: "airline.book-flight",
        description: "Book a flight for a passenger",
        parameters: z.object({
          flightId: z.string(),
          passengerId: z.string(),
        }),
      },
      async (ctx) => {
        const booking = await api.bookFlight(
          ctx.input.flightId,
          ctx.input.passengerId,
        );
        
        return withDisplay(
          { booking },
          { text: `Booking confirmed: ${booking.id}`, mimeType: "text/plain" },
        );
      },
    ),
    
    // ... more tools (cancel-booking, change-flight, etc.)
    
  }, {
    description: "Airline customer service API",
    directives: [
      "Use airline tools to help customers book, change, or cancel flights.",
      "Always verify availability before booking.",
      "Follow cancellation policy: must be >24h before departure.",
    ],
  });
}
```

**Step 4: Multi-Turn Orchestration**

```typescript
// packages/eval/src/tau-bench/multi-turn-runner.ts

export async function runTAUBenchTask(
  task: TAUBenchTask,
  agentModel: Model<Api>,
  userModel: Model<Api>,
): Promise<TAUBenchMetrics> {
  const api = new AirlineAPI(loadAirlineDatabase());
  const airlineOrgan = createAirlineOrgan(api);
  
  const agent = createCodingAgent({
    cwd: "/tmp/tau-bench",
    model: agentModel,
    organs: [airlineOrgan, "dialog", "llm"],
  });

  const userSimulator = new UserSimulator(task, userModel);
  const conversation: Message[] = [];
  
  let turn = 0;
  const maxTurns = 20;

  // Initial user message
  let userMessage = task.initialMessage;
  conversation.push({ role: "user", text: userMessage });

  while (turn < maxTurns) {
    // Agent responds
    const agentResponse = await agent.run({ text: userMessage });
    conversation.push({ role: "agent", text: agentResponse.text });

    // Check if task complete
    if (userSimulator.isTaskComplete(conversation)) {
      break;
    }

    // User simulator generates next message
    userMessage = await userSimulator.generateNextMessage(conversation);
    conversation.push({ role: "user", text: userMessage });
    
    turn++;
  }

  // Evaluate trajectory + outcome
  const trajectoryScore = evaluateTrajectory(conversation, task.referenceTrajectory);
  const outcomeScore = evaluateOutcome(api.database, task.expectedOutcome);

  return {
    taskId: task.id,
    success: outcomeScore === 1.0,
    trajectoryScore,
    outcomeScore,
    turns: conversation.length,
    toolCalls: extractToolCalls(conversation),
    policyViolations: detectPolicyViolations(conversation),
  };
}
```

**Step 5: Evaluation Checkers**

```typescript
// packages/eval/src/tau-bench/checkers.ts

export function evaluateTrajectory(
  actual: Message[],
  reference: ToolCall[],
): number {
  // Did agent use the expected tools in roughly the correct order?
  const actualTools = extractToolCalls(actual);
  
  let matchedSteps = 0;
  for (const refTool of reference) {
    if (actualTools.some(t => toolMatches(t, refTool))) {
      matchedSteps++;
    }
  }
  
  return matchedSteps / reference.length;
}

export function evaluateOutcome(
  database: AirlineDatabase,
  expected: OutcomeSpec,
): number {
  // Did the database reach the expected state?
  if (expected.type === "booking-created") {
    const booking = database.bookings.get(expected.bookingId);
    return booking?.status === "confirmed" ? 1.0 : 0.0;
  }
  
  if (expected.type === "booking-cancelled") {
    const booking = database.bookings.get(expected.bookingId);
    return booking?.status === "cancelled" ? 1.0 : 0.0;
  }
  
  return 0.0;
}

export function detectPolicyViolations(conversation: Message[]): string[] {
  const violations: string[] = [];
  
  // Example: did agent cancel a booking within 24h of departure?
  const cancelActions = extractToolCalls(conversation).filter(
    t => t.tool === "airline.cancel-booking"
  );
  
  for (const cancel of cancelActions) {
    const booking = /* lookup booking */;
    const flight = /* lookup flight */;
    const hoursUntilFlight = /* calculate */;
    
    if (hoursUntilFlight < 24) {
      violations.push("Cancelled booking within 24h of departure");
    }
  }
  
  return violations;
}
```

### 2.3 Cost Estimates

**TAU-bench (50 tasks, airline domain)**:
- Agent model: Claude Sonnet 4-5
- User simulator model: Claude Haiku (cheaper, sufficient for simulation)
- Estimated turns: 10 per task
- Tokens per turn: 5k input + 1k output (agent), 1k input + 500 output (user)
- Cost per task: ~$0.50 (agent) + ~$0.10 (user) = **$0.60**
- Total: 50 × $0.60 = **$30**

**Pass@k Strategy**:
- Run each task k=8 times (TAU-bench recommendation for stability)
- Total cost: 50 × 8 × $0.60 = **$240**

---

## 3. Metrics Collection & Reporting

### 3.1 Unified Metrics Schema

```typescript
// packages/eval/src/metrics.ts (extend existing)

export interface BenchmarkMetrics {
  benchmark: "swe-bench" | "tau-bench" | "webvoyager" | "osworld" | "internal";
  taskId: string;
  success: boolean;
  score: number;  // 0.0-1.0 (partial credit for internal evals)
  cost: number;   // USD
  duration: number;  // milliseconds
  turns: number;
  model: string;
  
  // Benchmark-specific fields
  swebench?: {
    repo: string;
    patchSize: number;
    testsPassed: number;
    linterErrors: number;
  };
  
  taubench?: {
    domain: string;
    trajectoryScore: number;
    outcomeScore: number;
    policyViolations: string[];
  };
  
  // Tool use tracking
  toolCalls: {
    tool: string;
    count: number;
    totalDuration: number;
    errorRate: number;
  }[];
  
  // OTel traces
  traces: OTelSpan[];
}
```

### 3.2 Scoreboard Extensions

```markdown
<!-- packages/eval/SCOREBOARD.md (extend) -->

## SWE-bench Verified

| Date | Model | Pass@1 | Cost/Task | Time/Task | Top Repo |
|------|-------|--------|-----------|-----------|----------|
| 2026-06-15 | claude-sonnet-4-5 | 62% | $1.85 | 4m 20s | django (75%) |

### Per-Repository Breakdown

| Repository | Tasks | Pass@1 | Avg Cost |
|------------|-------|--------|----------|
| django/django | 100 | 75% | $2.10 |
| pytest-dev/pytest | 80 | 58% | $1.60 |
| sympy/sympy | 70 | 45% | $2.50 |

## TAU-bench (Airline)

| Date | Model | Pass@1 | Pass@8 | Trajectory | Outcome | Policy Violations |
|------|-------|--------|--------|------------|---------|-------------------|
| 2026-06-15 | claude-sonnet-4-5 | 42% | 68% | 0.85 | 0.78 | 2/50 (4%) |

## Comparison to Published Results

| Benchmark | Alef | SWE-agent | Devin | OpenAI Operator | Claude Computer Use |
|-----------|------|-----------|-------|-----------------|---------------------|
| SWE-bench Verified | 62% | 72.8% | ~70% | N/A | N/A |
| TAU-bench (airline) | 42% | N/A | N/A | N/A | 52% (Opus 4.1) |
```

### 3.3 Dashboard Visualization

```typescript
// packages/eval/src/dashboard.ts (new file)

export function generateDashboard(metrics: BenchmarkMetrics[]): string {
  // Generate HTML dashboard with:
  // - Pass@1 over time (line chart)
  // - Cost distribution (histogram)
  // - Tool use heatmap (which tools used most often?)
  // - Per-benchmark comparison (bar chart)
  
  // Use lightweight charting library (e.g., Chart.js via CDN)
  // Output static HTML file that can be hosted on GitHub Pages
}
```

---

## 4. CI/CD Integration

### 4.1 Regression Suite (PR Gate)

```yaml
# .github/workflows/eval-regression.yml

name: Eval Regression Suite
on: [pull_request]

jobs:
  regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      
      - run: npm install
      - run: npm run build
      
      - name: Run Internal Eval Suite
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          ALEF_EVAL_MODEL: claude-sonnet-4-5
          ALEF_EVAL_N: 1  # Single run, temperature 0
        run: |
          cd packages/eval
          npm run test -- --reporter=json > results.json
      
      - name: Check 100% Pass Rate
        run: |
          PASS_RATE=$(jq '.passRate' packages/eval/results.json)
          if [ "$PASS_RATE" != "1.0" ]; then
            echo "Regression detected: pass rate = $PASS_RATE (expected 1.0)"
            exit 1
          fi
      
      - name: Upload Results
        uses: actions/upload-artifact@v4
        with:
          name: eval-results
          path: packages/eval/results.json
```

### 4.2 Nightly Capability Suite

```yaml
# .github/workflows/eval-nightly.yml

name: Nightly SWE-bench Run
on:
  schedule:
    - cron: '0 2 * * *'  # 2 AM UTC daily

jobs:
  swe-bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      
      - run: npm install && npm run build
      
      - name: Run SWE-bench Verified (full suite)
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          ALEF_EVAL_MODEL: claude-sonnet-4-5
          ALEF_EVAL_N: 5  # Pass@5 for variance
        run: |
          cd packages/eval
          npm run benchmark:swe-bench
      
      - name: Update Scoreboard
        run: |
          cd packages/eval
          node scripts/update-scoreboard.mjs
      
      - name: Commit Results
        run: |
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git add packages/eval/SCOREBOARD.md packages/eval/benchmark.jsonl
          git commit -m "chore: nightly SWE-bench results"
          git push
```

---

## 5. Implementation Checklist

### Phase 1: SWE-bench (Weeks 1-4)

- [ ] Load SWE-bench Verified dataset (500 instances)
- [ ] Implement `SWEBenchAdapter` (Alef session → Docker environment)
- [ ] Run 10-task smoke test (verify harness end-to-end)
- [ ] Run 50-task stratified sample (easy/medium/hard)
- [ ] Analyze failure modes (tool errors? planning? verification?)
- [ ] Optimize prompts + tool use
- [ ] Run full 500-task suite
- [ ] Submit to SWE-bench leaderboard
- [ ] Update `SCOREBOARD.md` with results

### Phase 2: TAU-bench (Weeks 5-8)

- [ ] Implement user simulator (LLM-based)
- [ ] Build airline API + database
- [ ] Create `AirlineOrgan` (search-flights, book-flight, cancel-booking)
- [ ] Run 10-task smoke test
- [ ] Run 50-task full suite (airline domain)
- [ ] Measure trajectory + outcome + policy compliance
- [ ] Update `SCOREBOARD.md` with TAU-bench results

### Phase 3: Dashboard & CI/CD (Weeks 9-10)

- [ ] Build unified metrics dashboard (HTML + charts)
- [ ] Set up PR regression gate (internal eval, 100% pass)
- [ ] Set up nightly SWE-bench runs
- [ ] Configure cost alerts (abort if budget exceeded)
- [ ] Publish dashboard to GitHub Pages

---

## 6. Open Questions

1. **Docker vs Local Execution**: Should SWE-bench run in Docker (reproducible but slow) or local workspace (fast but risky)? **Decision**: Use Docker for official runs, local for development iteration.

2. **Model Selection**: Should we run all benchmarks with Claude Sonnet 4-5 only, or test multiple models? **Decision**: Start with Sonnet 4-5 (current default), add Opus 4-6 and GPT-5 once baseline established.

3. **Cost Budgeting**: Who approves spending $1000 on a full SWE-bench run? **Decision**: Get approval before Phase 1 full run; start with $100 sample budget.

4. **Leaderboard Submission**: Do we submit to public leaderboards under "Alef" name or "Pi" name (since Alef is a fork)? **Decision**: Submit as "Alef" with attribution to Pi in README.

5. **WebVoyager/OSWorld**: Are these worth the implementation effort given Alef's coding focus? **Decision**: Defer to Phase 4 (exploration), focus on SWE-bench + TAU-bench first.

---

## 7. Conclusion

This implementation guide provides concrete steps for integrating SWE-bench and TAU-bench into Alef's evaluation harness. The architecture reuses existing `packages/eval` infrastructure (OTel traces, checkers, scoreboard) while adding benchmark-specific adapters.

**Next step**: Implement Phase 1 (SWE-bench integration) and run 10-task smoke test to validate approach before committing to full 500-task run.
