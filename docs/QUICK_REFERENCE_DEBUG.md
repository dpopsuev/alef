# Alef Debug Mode Quick Reference

## One-Command Debug

```bash
make debug
```

This single command:
- ✅ Creates XDG directories if they don't exist
- ✅ Migrates legacy `~/.alef` files
- ✅ Auto-loads the `debug-alef` skill
- ✅ Enables verbose logging (`ALEF_DEBUG=1`)
- ✅ Uses Claude Sonnet 4.5 with thinking mode
- ✅ Shows debug log location

## Debug Commands Reference

| Command | Description |
|---------|-------------|
| `make debug` | Run Alef with full debugging enabled |
| `make debug-watch` | Watch debug.log live (requires `jq`) |
| `make debug-errors` | Show only errors from debug.log |
| `make debug-tools` | Show tool execution timing summary |
| `make debug-clean` | Clear debug.log and session files |
| `make xdg-setup` | Setup/migrate XDG directories |
| `make xdg-info` | Show XDG paths and status |

## Log Locations (XDG-compliant)

```bash
# Debug log (pino JSON, rotates at 10MB)
~/.local/state/alef/debug.log

# Session logs (JSONL per session)
~/.local/share/alef/sessions/<cwd-hash>/<session-id>.jsonl

# Daemon registry
~/.local/state/alef/daemon.json

# Last session metadata
~/.local/state/alef/last-session.json
```

## Live Log Monitoring

```bash
# Watch all events
tail -f ~/.local/state/alef/debug.log | jq .

# Show only errors
tail -f ~/.local/state/alef/debug.log | jq 'select(.level >= 50)'

# Show tool calls only
tail -f ~/.local/state/alef/debug.log | jq 'select(.msg | startswith("tool:"))'

# Show LLM events only
tail -f ~/.local/state/alef/debug.log | jq 'select(.msg | startswith("llm:"))'

# Show delegation events
tail -f ~/.local/state/alef/debug.log | jq 'select(.msg | startswith("delegate:"))'
```

## Quick Filters

```bash
# Trace single tool call (by correlationId)
jq 'select(.correlationId == "CORR_ID")' ~/.local/state/alef/debug.log

# Show all tool execution timing
jq -r 'select(.msg == "tool:end") | "\(.name)\t\(.elapsedMs)ms\t\(if .ok then "✓" else "✗" end)"' \
  ~/.local/state/alef/debug.log | column -t

# Find hung tools (tool:start without tool:end)
comm -13 \
  <(jq -r 'select(.msg=="tool:end") | .callId' ~/.local/state/alef/debug.log | sort) \
  <(jq -r 'select(.msg=="tool:start") | .callId' ~/.local/state/alef/debug.log | sort)

# Show errors with stack traces
jq 'select(.level >= 50) | {time, organ, tool, msg, stack: .err.stack}' \
  ~/.local/state/alef/debug.log
```

## Debug Skill Features

The `debug-alef` skill (auto-loaded in debug mode) provides:

### Event Categories
- **Lifecycle**: `boot`, `tui:start`, `tui:stopped`, `tool:start`, `tool:end`, `loop:detected`
- **LLM timing**: `llm:phase:enter/exit`, `llm:http:start/done`, `llm:tool:subscribe/resolved`
- **Delegation**: `delegate:strategy:start/done`, `in-process:start/done/error`
- **Tool catalog**: `tools:describe:miss` (unknown tool requested)
- **Framework errors**: `stream action failed`, `corpus action failed`

### Hang Diagnosis
- **Tool hang**: `tool:start` without `tool:end`
- **LLM hang**: `llm:http:start` without `llm:http:done`
- **Tool stall**: `llm:tool:stall` without `llm:tool:resolved`

### Session JSONL Inspection

```bash
# Find session for current directory
HASH=$(echo -n $(pwd) | sha1sum | cut -c1-12)
SESSION=$(ls -t ~/.local/share/alef/sessions/$HASH/*.jsonl | head -1)

# View context window usage
jq -r 'select(.type=="window.assembled") | 
  "\(.payload.budgetUsed)/\(.payload.budgetTotal) = \((.payload.budgetUsed/.payload.budgetTotal*100)|round)%"' \
  $SESSION

# All tool calls in order
jq 'select(.bus=="motor" and (.type | startswith("fs.") or startswith("shell.") or startswith("agent."))) | 
  {type, correlationId}' $SESSION
```

## Common Debug Scenarios

### Scenario 1: Tool Hanging

```bash
# 1. Watch debug log
make debug-watch

# 2. Look for tool:start without tool:end
grep -B2 -A2 "tool:start" ~/.local/state/alef/debug.log | tail -20

# 3. Find the correlation ID and trace it
jq 'select(.correlationId == "FOUND_CORR_ID")' ~/.local/state/alef/debug.log
```

### Scenario 2: LLM Not Responding

```bash
# 1. Check for llm:http events
jq 'select(.msg | startswith("llm:http"))' ~/.local/state/alef/debug.log | tail -10

# 2. Look for llm:tool:stall (5s timeout)
jq 'select(.msg == "llm:tool:stall")' ~/.local/state/alef/debug.log

# 3. Check for llm:tool:timeout
jq 'select(.msg == "llm:tool:timeout")' ~/.local/state/alef/debug.log
```

### Scenario 3: Unknown Tool Error

```bash
# Find tools:describe:miss events (tool LLM tried to use but wasn't available)
jq 'select(.msg == "tools:describe:miss") | {name, available}' \
  ~/.local/state/alef/debug.log
```

### Scenario 4: Agent Delegation Issues

```bash
# Trace delegation flow
jq 'select(.msg | startswith("delegate:") or .msg | startswith("in-process:"))' \
  ~/.local/state/alef/debug.log | jq '{msg, profile, elapsedMs, ok, err: .err.message}'
```

## Environment Variables

```bash
# Enable debug mode (equivalent to --debug flag)
export ALEF_DEBUG=1

# Set log level explicitly
export ALEF_LOG_LEVEL=debug

# Custom XDG paths (optional)
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_CACHE_HOME="$HOME/.cache"
```

## Headless Debug Mode

Run without TUI to see all events in terminal:

```bash
ALEF_LOG_LEVEL=debug alef --no-tui -p "your prompt here" 2>&1 | jq .
```

## Daemon Debug

```bash
# Check daemon is running
cat ~/.local/state/alef/daemon.json | jq .

# Health check
curl http://127.0.0.1:$(jq .port ~/.local/state/alef/daemon.json)/health

# Watch daemon SSE stream
curl -N http://127.0.0.1:$(jq .port ~/.local/state/alef/daemon.json)/events
```

## Troubleshooting

### Debug log not created
```bash
# Must run with --debug or ALEF_DEBUG=1
ALEF_DEBUG=1 alef
# or
make debug
```

### debug-alef skill not loading
```bash
# Check skill exists
ls -la ~/.config/alef/skills/debug-alef/SKILL.md

# Re-run XDG setup
make xdg-setup

# Verify frontmatter
head -5 ~/.config/alef/skills/debug-alef/SKILL.md
```

### Logs filling up disk
```bash
# Logs auto-rotate at 10MB, keeping 3 files
# Manual cleanup:
make debug-clean
```

## See Also

- [Full XDG Setup Documentation](./XDG_SETUP.md)
- [Debug Skill Source](../packages/runner/src/skills/debug-alef/SKILL.md)
- [XDG Paths Module](../packages/runner/src/xdg-paths.ts)
