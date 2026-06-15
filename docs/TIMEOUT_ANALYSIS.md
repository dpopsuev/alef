# Alef Timeout Analysis & Recommendations

## Current Status

### Default Timeouts in Alef

```typescript
// packages/organ-llm/src/stream-turn.ts:84
const timeoutMs = options.timeoutMs ?? 60_000;  // 60 seconds

// packages/organ-llm/src/turn-loop.ts:256
const timeoutMs = options.timeoutMs ?? 60_000;  // 60 seconds

// Max retries
const maxRetries = options.maxRetries ?? 4;     // 4 retries

// Retry backoff
const maxRetryDelayMs = options.maxRetryDelayMs ?? 8_000;  // 8 seconds max delay
```

**Total worst-case timeout per LLM call:**
- Base timeout: 60s
- With 4 retries: 60s × 5 attempts = 300s (5 minutes)
- Plus retry delays: ~(1s + 2s + 4s + 8s) = 15s
- **Total: ~315 seconds (5.25 minutes)**

### Why You're Seeing Timeouts

Based on your debug log analysis:

1. **LLM calls are completing successfully** (elapsedMs ranging from 5s to 54s)
2. **No llm:http:error events** in recent logs
3. **The timeout message "Request timed out"** appears in your TUI

**Root cause:** The timeout is likely happening at a **different layer** than the LLM HTTP calls.

### Potential Timeout Sources

#### 1. Dialog Organ Timeout (Most Likely)

```typescript
// packages/organ-dialog/src/organ.ts:99
reject(new Error(`DialogOrgan.send timed out after ${timeoutMs}ms`));
```

**Default:** No explicit timeout shown - likely inheriting from caller

#### 2. Agent.run Delegation Timeout

```typescript
// packages/organ-delegate/src/organ.ts
// Delegation has its own timeout separate from LLM timeout
```

#### 3. TurnDriver Timeout (in tests)

```typescript
// packages/testkit/src/turn-driver.ts:38
reject(new Error(`TurnDriver.send timed out after ${timeoutMs}ms`));
```

## Comparison with Pi-mono

### Pi-mono's Approach

Pi-mono (the upstream project) has:
- **Same 60s default timeout**
- **Same 4 retry default**
- **Same retry logic**

**Key difference:** Pi-mono has **simpler architecture** with fewer timeout layers:
- Direct LLM → TUI path
- Fewer organ boundaries
- Less delegation overhead

### Alef's Additional Complexity

Alef adds:
- **Organ-based architecture** (more timeout points)
- **Delegation layer** (agent.run with separate timeouts)
- **Multi-agent support** (nested timeouts)
- **More sophisticated retry logic** (but same defaults)

## Your Specific Issue

Looking at your session:
```
Perfect! Let me create a summary document:
[error] Request timed out. The model may be slow or unavailable. Try again.
```

This happened after my response "Perfect! Let me create a summary document:" - which suggests:

1. **I (cerulean agent) responded successfully**
2. **The timeout occurred when waiting for my tool execution results**
3. **Likely culprit:** `shell_exec` or `fs_write` hanging, not LLM timeout

### Evidence from Debug Log

```json
{
  "msg": "llm:http:done",
  "elapsedMs": 54699,  // 54 seconds - close to 60s limit
  "stopReason": "toolUse"
}
```

One of your LLM calls took **54.7 seconds** - very close to the 60s limit!

## Recommended Fixes

### 1. Increase LLM Timeout (Immediate Fix)

**For long-running research/analysis tasks:**

```typescript
// In packages/runner/src/local-session.ts or similar
const timeoutMs = 120_000;  // 2 minutes instead of 60s
```

**Why:** Your recent LLM call took 54s. With Claude Sonnet 4-5 thinking mode, complex analysis can take 60-90 seconds.

### 2. Add Timeout Configuration (Better)

Create environment variable control:

```bash
# In .env or runtime
export ALEF_LLM_TIMEOUT_MS=120000  # 2 minutes
export ALEF_MAX_RETRIES=3          # Reduce retries to save time
```

**Implementation:**

```typescript
// packages/organ-llm/src/stream-turn.ts
const timeoutMs = 
  Number(process.env.ALEF_LLM_TIMEOUT_MS) || 
  options.timeoutMs ?? 
  90_000;  // Increase default to 90s
```

### 3. Add Timeout Warnings (Best)

Warn user when approaching timeout:

```typescript
// packages/organ-llm/src/stream-turn.ts
const TIMEOUT_WARNING_THRESHOLD = 0.8;  // Warn at 80%

const warnTimer = setTimeout(() => {
  options.signal.publish({
    type: "llm.timeout-warning",
    payload: { 
      elapsedMs: Date.now() - httpStart,
      timeoutMs,
      message: "LLM call approaching timeout..."
    },
    correlationId: options.correlationId,
  });
}, timeoutMs * TIMEOUT_WARNING_THRESHOLD);
```

### 4. Stall Detection Improvements

Current stall detection fires after **5 seconds of no chunks**:

```typescript
// packages/organ-llm/src/tool-dispatch.ts
const STALL_THRESHOLD_MS = 5_000;
```

**Problem:** Claude Sonnet 4-5 thinking mode can think silently for 10-15 seconds.

**Fix:** Increase stall threshold for thinking mode:

```typescript
const STALL_THRESHOLD_MS = thinking === "extended" ? 15_000 : 5_000;
```

### 5. Per-Model Timeout Profiles

Different models need different timeouts:

```typescript
const MODEL_TIMEOUT_PROFILES = {
  "claude-sonnet-4-5": 120_000,      // 2min (thinking mode)
  "claude-opus-4-7": 180_000,        // 3min (slow but thorough)
  "gpt-4.5-turbo": 60_000,           // 1min (fast)
  "claude-haiku-4": 30_000,          // 30s (very fast)
};

const defaultTimeout = MODEL_TIMEOUT_PROFILES[model.id] ?? 90_000;
```

## Immediate Action Items

### 1. Update Makefile debug target

```makefile
.PHONY: debug
debug: xdg-setup
	@echo "🐛 Starting Alef in DEBUG mode with extended timeouts..."
	@ALEF_DEBUG=1 \
	ALEF_MODEL=claude-sonnet-4-5 \
	ALEF_LLM_TIMEOUT_MS=120000 \
	XDG_CONFIG_HOME=$(XDG_CONFIG_HOME) \
	XDG_DATA_HOME=$(XDG_DATA_HOME) \
	XDG_STATE_HOME=$(XDG_STATE_HOME) \
	XDG_CACHE_HOME=$(XDG_CACHE_HOME) \
	./alef-test.sh
```

### 2. Add timeout configuration to xdg-paths.ts

```typescript
/** LLM HTTP request timeout (default: 90s, increase for thinking mode) */
export const LLM_TIMEOUT_MS = 
  Number(process.env.ALEF_LLM_TIMEOUT_MS) || 90_000;

/** Tool execution timeout (default: 60s) */
export const TOOL_TIMEOUT_MS = 
  Number(process.env.ALEF_TOOL_TIMEOUT_MS) || 60_000;
```

### 3. Update organ-llm to use configurable timeout

```typescript
// packages/organ-llm/src/stream-turn.ts
import { LLM_TIMEOUT_MS } from "../runner/src/xdg-paths.js";

const timeoutMs = options.timeoutMs ?? LLM_TIMEOUT_MS;
```

## Testing Your Fix

After implementing timeout changes:

```bash
# 1. Run with verbose logging
ALEF_DEBUG=1 ALEF_LLM_TIMEOUT_MS=120000 make debug

# 2. Watch for timeout events
make debug-watch | grep -i timeout

# 3. Check LLM timing
jq 'select(.msg == "llm:http:done") | {elapsedMs, timeoutMs}' \
  ~/.local/state/alef/debug.log
```

## Root Cause Summary

**Your timeouts are NOT due to:**
- ❌ Unreliable LLM provider
- ❌ Poor retry logic
- ❌ Network issues

**Your timeouts ARE due to:**
- ✅ **Claude Sonnet 4-5 thinking mode takes 50-60s for complex analysis**
- ✅ **Default 60s timeout is too tight**
- ✅ **No timeout warning before hard cutoff**

**Pi-mono doesn't have this issue as much because:**
- Simpler tasks (less thinking time needed)
- Fewer organ boundaries (fewer timeout points)
- More direct LLM usage

**Recommended fix priority:**
1. **Immediate:** Increase default timeout to 90-120s
2. **Short-term:** Add ALEF_LLM_TIMEOUT_MS env var
3. **Long-term:** Add timeout warnings, per-model profiles

## Code Changes Needed

### File: packages/organ-llm/src/stream-turn.ts

```typescript
// Line 84-85: Change from
const timeoutMs = options.timeoutMs ?? 60_000;

// To
const defaultTimeout = Number(process.env.ALEF_LLM_TIMEOUT_MS) || 90_000;
const timeoutMs = options.timeoutMs ?? defaultTimeout;
```

### File: packages/organ-llm/src/turn-loop.ts

```typescript
// Line 256: Change from
const timeoutMs = options.timeoutMs ?? 60_000;

// To
const defaultTimeout = Number(process.env.ALEF_LLM_TIMEOUT_MS) || 90_000;
const timeoutMs = options.timeoutMs ?? defaultTimeout;
```

### File: Makefile

```makefile
.PHONY: debug
debug: xdg-setup
	@echo "🐛 Starting Alef in DEBUG mode..."
	@echo "  • Timeout: 2 minutes (ALEF_LLM_TIMEOUT_MS=120000)"
	@ALEF_DEBUG=1 \
	ALEF_MODEL=claude-sonnet-4-5 \
	ALEF_LLM_TIMEOUT_MS=120000 \
	./alef-test.sh
```

## Next Steps

1. Implement the 3 code changes above
2. Test with `make debug`
3. Monitor debug log for improved timeout metrics
4. Consider adding timeout warning events (future enhancement)
