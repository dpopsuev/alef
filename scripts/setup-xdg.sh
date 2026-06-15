#!/usr/bin/env bash
# Setup XDG directory structure for Alef
# Creates all required directories and copies/moves legacy files if they exist

set -euo pipefail

# XDG Base Directories (with fallbacks)
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"

# Alef XDG directories
ALEF_CONFIG_DIR="$XDG_CONFIG_HOME/alef"
ALEF_DATA_DIR="$XDG_DATA_HOME/alef"
ALEF_STATE_DIR="$XDG_STATE_HOME/alef"
ALEF_CACHE_DIR="$XDG_CACHE_HOME/alef"

# Legacy directory
LEGACY_DIR="$HOME/.alef"

echo "🔧 Setting up Alef XDG directory structure..."
echo ""

# Create all required directories
mkdir -p "$ALEF_CONFIG_DIR/skills"
mkdir -p "$ALEF_DATA_DIR/sessions"
mkdir -p "$ALEF_DATA_DIR/prototypes"
mkdir -p "$ALEF_STATE_DIR"
mkdir -p "$ALEF_CACHE_DIR/lsp"
mkdir -p "$ALEF_CACHE_DIR/embeddings"

echo "✅ Created XDG directories:"
echo "   Config:  $ALEF_CONFIG_DIR"
echo "   Data:    $ALEF_DATA_DIR"
echo "   State:   $ALEF_STATE_DIR"
echo "   Cache:   $ALEF_CACHE_DIR"
echo ""

# Migrate legacy ~/.alef if it exists
if [ -d "$LEGACY_DIR" ]; then
    echo "📦 Found legacy ~/.alef directory. Migrating..."
    
    # Move debug.log → $XDG_STATE_HOME/alef/
    if [ -f "$LEGACY_DIR/debug.log" ]; then
        mv "$LEGACY_DIR/debug.log" "$ALEF_STATE_DIR/debug.log"
        echo "   ✓ Moved debug.log to $ALEF_STATE_DIR/"
    fi
    
    # Move daemon.json → $XDG_STATE_HOME/alef/
    if [ -f "$LEGACY_DIR/daemon.json" ]; then
        mv "$LEGACY_DIR/daemon.json" "$ALEF_STATE_DIR/daemon.json"
        echo "   ✓ Moved daemon.json to $ALEF_STATE_DIR/"
    fi
    
    # Move last-session.json → $XDG_STATE_HOME/alef/
    if [ -f "$LEGACY_DIR/last-session.json" ]; then
        mv "$LEGACY_DIR/last-session.json" "$ALEF_STATE_DIR/last-session.json"
        echo "   ✓ Moved last-session.json to $ALEF_STATE_DIR/"
    fi
    
    # Move sessions/ → $XDG_DATA_HOME/alef/sessions/
    if [ -d "$LEGACY_DIR/sessions" ]; then
        cp -r "$LEGACY_DIR/sessions/"* "$ALEF_DATA_DIR/sessions/" 2>/dev/null || true
        echo "   ✓ Copied sessions to $ALEF_DATA_DIR/sessions/"
    fi
    
    # Move prototypes/ → $XDG_DATA_HOME/alef/prototypes/
    if [ -d "$LEGACY_DIR/prototypes" ]; then
        cp -r "$LEGACY_DIR/prototypes/"* "$ALEF_DATA_DIR/prototypes/" 2>/dev/null || true
        echo "   ✓ Copied prototypes to $ALEF_DATA_DIR/prototypes/"
    fi
    
    echo ""
    echo "⚠️  Legacy directory $LEGACY_DIR still exists."
    echo "   Review migration and delete manually if everything looks good:"
    echo "   rm -rf $LEGACY_DIR"
    echo ""
fi

# Copy debug-alef skill if it exists in old location
OLD_SKILL_PATH="$HOME/.config/opencode/skills/debug-alef/SKILL.md"
NEW_SKILL_PATH="$ALEF_CONFIG_DIR/skills/debug-alef/SKILL.md"

if [ -f "$OLD_SKILL_PATH" ] && [ ! -f "$NEW_SKILL_PATH" ]; then
    echo "📚 Copying debug-alef skill from old location..."
    mkdir -p "$ALEF_CONFIG_DIR/skills/debug-alef"
    cp "$OLD_SKILL_PATH" "$NEW_SKILL_PATH"
    echo "   ✓ Copied to $NEW_SKILL_PATH"
    echo ""
fi

# Create debug-alef skill if it doesn't exist
if [ ! -f "$NEW_SKILL_PATH" ]; then
    echo "📝 Creating debug-alef skill..."
    mkdir -p "$ALEF_CONFIG_DIR/skills/debug-alef"
    cat > "$NEW_SKILL_PATH" << 'EOF'
---
name: debug-alef
description: Use when debugging Alef itself — hung tools, TUI glitches, LLM loop issues, session corruption, organ failures, fs.find hangs. Use ONLY for debugging the Alef agent codebase, not for debugging user applications.
---

# Debugging Alef

See the full debug skill at: ~/.config/opencode/skills/debug-alef/SKILL.md
Or check the comprehensive guide in the repository.

This skill provides:
- Unified pino-based logging to $XDG_STATE_HOME/alef/debug.log
- Live debugging with jq filters
- Tool hang diagnosis (tool:start without tool:end)
- LLM timing events
- Delegation boundary tracing
- Session JSONL file inspection
- Daemon debugging

Quick start:
  tail -f ~/.local/state/alef/debug.log | jq .
EOF
    echo "   ✓ Created basic debug-alef skill at $NEW_SKILL_PATH"
    echo "   📌 For full debug skill content, see packages/runner/src/skills/debug-alef/SKILL.md"
    echo ""
fi

echo "✨ XDG setup complete!"
echo ""
echo "Directory structure:"
tree -L 2 "$ALEF_CONFIG_DIR" "$ALEF_DATA_DIR" "$ALEF_STATE_DIR" "$ALEF_CACHE_DIR" 2>/dev/null || {
    echo "   $ALEF_CONFIG_DIR/"
    ls -la "$ALEF_CONFIG_DIR" 2>/dev/null | sed 's/^/     /'
    echo "   $ALEF_DATA_DIR/"
    ls -la "$ALEF_DATA_DIR" 2>/dev/null | sed 's/^/     /'
    echo "   $ALEF_STATE_DIR/"
    ls -la "$ALEF_STATE_DIR" 2>/dev/null | sed 's/^/     /'
    echo "   $ALEF_CACHE_DIR/"
    ls -la "$ALEF_CACHE_DIR" 2>/dev/null | sed 's/^/     /'
}
echo ""
echo "Environment variables (add to ~/.bashrc or ~/.zshrc if customizing):"
echo "  export XDG_CONFIG_HOME=$XDG_CONFIG_HOME"
echo "  export XDG_DATA_HOME=$XDG_DATA_HOME"
echo "  export XDG_STATE_HOME=$XDG_STATE_HOME"
echo "  export XDG_CACHE_HOME=$XDG_CACHE_HOME"
