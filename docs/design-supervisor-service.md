# Design: Supervisor Service

## Status: Proposal (builds on design-tui-backend-split.md)

## Problem

The supervisor from Phase 3 is a simple process manager. It needs to become a proper service manager that handles:

1. **Updates** — `alef update` should go through the supervisor, not the running agent
2. **Self-update** — the supervisor binary itself must be replaceable
3. **Pre-flight checks** — verify the system is healthy before serving
4. **Heartbeat** — detect and recover from hung agents (Erlang `heart` pattern)

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Supervisor Service                     │
│                                                          │
│  ┌──────────────┐                                        │
│  │ Lifecycle    │  Pre-flight → Green → Monitor → Update │
│  │ State Machine│                                        │
│  └──────┬───────┘                                        │
│         │                                                │
│  ┌──────┴───────┐  ┌────────────┐  ┌──────────────────┐ │
│  │ Agent Broker │  │ Health     │  │ Update Manager   │ │
│  │              │  │ Monitor    │  │                  │ │
│  │ spawn/kill   │  │ heartbeat  │  │ self-update      │ │
│  │ restart      │  │ watchdog   │  │ blue-green       │ │
│  │ OTP policies │  │ pre-flight │  │ rollback         │ │
│  └──────────────┘  └────────────┘  └──────────────────┘ │
│         │                                                │
│    ┌────┴────────────────────┐                           │
│    │ Managed Processes       │                           │
│    ├─────────────────────────┤                           │
│    │ Green Agent (IPC)       │                           │
│    │ Subagent 1              │                           │
│    │ Subagent 2              │                           │
│    │ Blue Agent (smoke test) │                           │
│    └─────────────────────────┘                           │
└──────────────────────────────────────────────────────────┘
```

## Lifecycle State Machine

```
    ┌──────────┐
    │  INIT    │
    └────┬─────┘
         │ run pre-flight checks
         ▼
    ┌──────────┐  fail    ┌──────────┐
    │PREFLIGHT ├─────────►│  FAILED  │
    └────┬─────┘          └────┬─────┘
         │ pass                │ retry after delay
         ▼                    │
    ┌──────────┐◄─────────────┘
    │  GREEN   │ spawn green agent, start heartbeat
    └────┬─────┘
         │ /rebuild or /update
         ▼
    ┌──────────┐
    │ BUILDING │ npm run build (or npm update)
    └────┬─────┘
         │ build complete
         ▼
    ┌──────────┐
    │  BLUE    │ spawn blue agent, run smoke tests
    └────┬─────┘
         │ pass         │ fail
         ▼              ▼
    ┌──────────┐   ┌──────────┐
    │ PROMOTE  │   │ ROLLBACK │ restart previous green
    └────┬─────┘   └────┬─────┘
         │              │
         ▼              ▼
    ┌──────────┐   ┌──────────┐
    │  GREEN   │   │  GREEN   │ (old build)
    └──────────┘   └──────────┘

    At any time:
    ┌──────────┐  heartbeat timeout   ┌──────────┐
    │  GREEN   ├─────────────────────►│ RECOVERY │
    └──────────┘                      └────┬─────┘
                                           │ kill + respawn
                                           ▼
                                      ┌──────────┐
                                      │  GREEN   │
                                      └──────────┘
```

## Pre-flight Checks

Before the green agent starts, verify:

| Check | How | Required |
|-------|-----|----------|
| **Build exists** | `dist/main.js` exists | Yes |
| **TypeScript valid** | `npm run check` (cached — skip if last build passed) | No (slow) |
| **Core imports** | `node -e "require('./dist/index.js')"` | Yes |
| **Provider auth** | At least one provider has credentials | Warning only |
| **Session valid** | If `--session`, file exists and is parseable | Yes (if resuming) |
| **Extensions load** | Import each extension, call factory | Warning only |
| **Disk space** | Session dir has > 100MB free | Warning only |

Pre-flight runs once at startup and after each build. Results are cached — if the last build passed pre-flight, skip on next startup unless `--preflight-force`.

## Heartbeat / Watchdog

Inspired by Erlang's `heart` module:

- Supervisor sends heartbeat request to green agent via IPC every 30 seconds
- Green agent must respond within 10 seconds
- If 3 consecutive heartbeats fail: kill and respawn
- Heartbeat includes basic health data: memory usage, event loop lag, active tool calls

```typescript
// Supervisor → Agent
{ type: "heartbeat", seq: number }

// Agent → Supervisor
{ type: "heartbeat_ack", seq: number, health: {
  memoryMB: number,
  eventLoopLagMs: number,
  isStreaming: boolean,
  activeToolCalls: number,
  uptime: number,
}}
```

## Self-Update

The supervisor must be able to update itself. The pattern (from Erlang release handling and Chrome's update mechanism):

1. Build new supervisor code (part of `npm run build`)
2. Spawn new supervisor as a child process with a probe flag (`--probe`)
3. New supervisor runs pre-flight, spawns a test green agent
4. If test passes: new supervisor sends "ready" to old supervisor
5. Old supervisor exec-replaces itself with the new supervisor
6. If test fails: old supervisor kills the probe and continues

On Unix, step 5 uses `process.execPath` replacement — the old process becomes the new one, keeping the same PID and terminal. On platforms without exec, the old supervisor spawns the new one with `stdio: "inherit"` and exits.

```
Old Supervisor                    New Supervisor (probe)
     │                                  │
     ├── spawn with --probe ───────────►│
     │                                  ├── pre-flight checks
     │                                  ├── spawn test green
     │                                  ├── smoke tests
     │                   "ready" ◄──────┤
     │                                  │
     ├── kill probe ───────────────────►│ (dies)
     ├── exec-replace self with new binary
     │   (same PID, same terminal)
     ▼
New Supervisor (promoted)
     ├── spawn green agent
     └── normal operation
```

## Update Manager

Handles three update scenarios:

| Scenario | Trigger | Flow |
|----------|---------|------|
| **Code rebuild** | `/rebuild` | Build → blue-green → promote |
| **Package update** | `/update` or `alef update` | npm update → build → blue-green → promote |
| **Self update** | `alef update --self` | npm update self → build → self-replace → blue-green → promote |

All three go through the same blue-green validation pipeline. The difference is what changes before the build step.

## Rollback

If the blue agent fails smoke tests:

1. Log the failure (which tests failed, stderr output)
2. Keep the old build artifacts untouched (they're already in `dist/`)
3. Restart the green agent from the old build
4. Notify the user via the agent session ("Build failed smoke tests, rolled back")

For self-update rollback: the old supervisor never exec-replaces, so it's still running. It just kills the probe and continues.

## IPC Protocol Additions

New messages added to the broker protocol:

```typescript
// Supervisor → Agent
| { type: "heartbeat"; seq: number }
| { type: "preflight_result"; passed: boolean; checks: PreflightCheck[] }

// Agent → Supervisor
| { type: "heartbeat_ack"; seq: number; health: HealthData }
| { type: "update"; scope: "rebuild" | "packages" | "self" }
```

## Configuration

In `settings.json`:

```json
{
  "supervisor": {
    "heartbeatIntervalMs": 30000,
    "heartbeatTimeoutMs": 10000,
    "maxMissedHeartbeats": 3,
    "preflightOnStartup": true,
    "preflightOnBuild": true,
    "smokeTests": [
      "Respond with exactly: HEALTH_CHECK_OK",
      "What is 2+2? Reply with just the number."
    ],
    "smokeTestTimeoutMs": 30000
  }
}
```

## Implementation Phases

| Phase | What | Effort |
|-------|------|--------|
| 3a (done) | Basic supervisor + blue-green + broker | Done |
| 3b | Pre-flight checks at startup | Small |
| 3c | Heartbeat watchdog | Small |
| 3d | Update manager (rebuild + packages) | Medium |
| 3e | Self-update with exec-replace | Medium |
| 3f | Rollback with notification | Small |

## Prior Art

| System | Relevant Pattern | What We Took |
|--------|-----------------|--------------|
| Erlang/OTP `heart` | External watchdog, heartbeat, reboot command | Heartbeat protocol, external process model |
| Erlang/OTP `release_handler` | Hot code upgrade, rollback | Blue-green validation, rollback on failure |
| systemd | Watchdog, restart policies, exec-replace | `WatchdogSec`, `Type=notify`, restart intensity |
| Chrome updater | Background download, swap, restart | Self-update probe pattern |
| PM2 | Process manager, graceful reload, cluster | Zero-downtime restart inspiration |
| Kubernetes | Readiness/liveness probes, rolling update | Pre-flight = readiness, heartbeat = liveness |
