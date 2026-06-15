# Alef XDG Directory Setup

Alef follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html) for organizing user-specific files.

## Quick Start

```bash
# Setup XDG directories (run once)
make xdg-setup

# Check current XDG status
make xdg-info

# Run Alef in debug mode
make debug
```

## Directory Structure

### Configuration (`$XDG_CONFIG_HOME/alef`)

Default: `~/.config/alef`

```
~/.config/alef/
├── theme.yaml              # Custom TUI theme (optional)
├── config.yaml             # User preferences (optional)
└── skills/                 # User skill library
    ├── debug-alef/         # Alef debugging skill
    │   └── SKILL.md
    └── custom-skill/       # Your custom skills
        └── SKILL.md
```

**Purpose:** User-specific configuration files that should persist across updates.

### Data (`$XDG_DATA_HOME/alef`)

Default: `~/.local/share/alef`

```
~/.local/share/alef/
├── sessions/               # Session JSONL logs
│   ├── <cwd-hash>/        # Per-directory sessions
│   │   ├── <session-id>.jsonl
│   │   └── latest         # Symlink to most recent
│   └── ...
└── prototypes/            # User-written organ prototypes
    └── custom-organ.ts
```

**Purpose:** User-specific data files that should persist across updates.

**Session storage:**
- Sessions organized by `sha1(cwd)[0:12]` hash
- Each session is a JSONL file (one JSON object per line)
- `latest` points to the most recent session for that directory

### State (`$XDG_STATE_HOME/alef`)

Default: `~/.local/state/alef`

```
~/.local/state/alef/
├── debug.log              # Pino debug trace (rotates at 10MB, keeps 3 files)
├── daemon.json            # Daemon registry (port, pid, session)
└── last-session.json      # Most recent session metadata
```

**Purpose:** State data (logs, history, runtime information). Can be deleted without data loss.

**Debug log:**
- Pino JSON format (one JSON object per line)
- Rotates at 10MB
- Keeps 3 rotated files
- Enable with `--debug` or `ALEF_DEBUG=1`

### Cache (`$XDG_CACHE_HOME/alef`)

Default: `~/.cache/alef`

```
~/.cache/alef/
├── lsp/                   # TypeScript LSP cache
└── embeddings/            # Vector embedding cache
```

**Purpose:** Non-essential cached data. Can be deleted safely.

## Environment Variables

Alef respects standard XDG environment variables:

```bash
# Set custom XDG paths (optional)
export XDG_CONFIG_HOME="$HOME/.config"    # Default: ~/.config
export XDG_DATA_HOME="$HOME/.local/share" # Default: ~/.local/share
export XDG_STATE_HOME="$HOME/.local/state"# Default: ~/.local/state
export XDG_CACHE_HOME="$HOME/.cache"      # Default: ~/.cache
```

Add to `~/.bashrc` or `~/.zshrc` to persist across sessions.

## Migration from Legacy `~/.alef`

If you have an existing `~/.alef` directory, `make xdg-setup` will automatically migrate:

```
~/.alef/debug.log         → $XDG_STATE_HOME/alef/debug.log
~/.alef/daemon.json       → $XDG_STATE_HOME/alef/daemon.json
~/.alef/last-session.json → $XDG_STATE_HOME/alef/last-session.json
~/.alef/sessions/         → $XDG_DATA_HOME/alef/sessions/
~/.alef/prototypes/       → $XDG_DATA_HOME/alef/prototypes/
```

After migration, review and manually delete `~/.alef`:
```bash
rm -rf ~/.alef
```

## Debug Mode

The `make debug` target automatically:
1. Runs `make xdg-setup` to ensure directories exist
2. Sets `ALEF_DEBUG=1` for verbose logging
3. Uses `claude-sonnet-4-5` with thinking mode
4. Auto-loads the `debug-alef` skill from `$XDG_CONFIG_HOME/alef/skills/`

### Debug Commands

```bash
# Run in debug mode
make debug

# Watch debug log live (requires jq)
make debug-watch
# Or manually:
tail -f ~/.local/state/alef/debug.log | jq .

# Show only errors
make debug-errors

# Show tool execution timing
make debug-tools

# Clean debug artifacts
make debug-clean
```

### Debug Log Filters

```bash
# Filter by correlation ID (traces single tool call end-to-end)
jq 'select(.correlationId == "CORR_ID")' ~/.local/state/alef/debug.log

# Filter by organ
jq 'select(.organ == "delegate")' ~/.local/state/alef/debug.log

# Filter by log level (30=info, 20=debug, 40=warn, 50=error)
jq 'select(.level >= 40)' ~/.local/state/alef/debug.log

# See errors with stack traces
jq 'select(.level >= 50) | {msg, err: .err.stack}' ~/.local/state/alef/debug.log

# Tool execution summary
jq -r 'select(.msg == "tool:end") | "\(.name)\t\(.elapsedMs)ms\t\(if .ok then "✓" else "✗" end)"' \
  ~/.local/state/alef/debug.log | column -t
```

## Project-Local Configuration

In addition to XDG user directories, Alef supports project-local configuration:

```
<project-root>/.alef/
├── directives/           # Project-specific system prompts
└── skills/              # Project-specific skills
```

Project-local skills override user skills when working in that directory.

## Code Integration

TypeScript code can import XDG paths:

```typescript
import {
  ALEF_CONFIG_DIR,
  ALEF_DATA_DIR,
  ALEF_STATE_DIR,
  ALEF_CACHE_DIR,
  DEBUG_LOG_PATH,
  USER_SKILLS_DIR,
  SESSIONS_DIR,
} from './xdg-paths';
```

See `packages/runner/src/xdg-paths.ts` for all available paths.

## Debugging XDG Setup

```bash
# Show current XDG configuration
make xdg-info

# Manually verify directories
ls -la ~/.config/alef
ls -la ~/.local/share/alef
ls -la ~/.local/state/alef
ls -la ~/.cache/alef

# Check debug skill
cat ~/.config/alef/skills/debug-alef/SKILL.md

# Check debug log exists
ls -lh ~/.local/state/alef/debug.log
```

## Troubleshooting

### Debug log not created

The debug log is only created when Alef runs with `--debug` or `ALEF_DEBUG=1`:
```bash
ALEF_DEBUG=1 alef
# or
make debug
```

### Skills not loading

1. Check skill file exists:
   ```bash
   ls -la ~/.config/alef/skills/debug-alef/SKILL.md
   ```

2. Verify YAML frontmatter:
   ```bash
   head -5 ~/.config/alef/skills/debug-alef/SKILL.md
   ```

Should show:
```yaml
---
name: debug-alef
description: ...
---
```

3. Run with debug to see skill discovery:
   ```bash
   ALEF_DEBUG=1 alef --debug 2>&1 | grep -i skill
   ```

### Sessions not persisting

Sessions are stored by `sha1(cwd)` hash. Check:
```bash
HASH=$(echo -n $(pwd) | sha1sum | cut -c1-12)
ls -la ~/.local/share/alef/sessions/$HASH/
```

## References

- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html)
- [Alef Debug Skill](../packages/runner/src/skills/debug-alef/SKILL.md)
- [XDG Paths TypeScript Module](../packages/runner/src/xdg-paths.ts)
