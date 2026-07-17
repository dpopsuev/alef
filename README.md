<p align="center">
  <a href="https://github.com/dpopsuev/alef"><strong>Alef Agent</strong></a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
</p>

> This fork is maintained BDFL-style; outside contributions are not accepted. Source is open to read and to fork (MIT). See [CONTRIBUTING.md](CONTRIBUTING.md).

---

# Alef Agent Harness Monorepo

This repository contains the Alef CLI app, runtime, blueprint, and supporting packages.

* **[@dpopsuev/alef-kernel](packages/core/kernel)**: Microkernel — buses, adapter framework, binding chain, contributions
* **[@dpopsuev/alef-runtime](packages/core/runtime)**: Agent class, AgentController, delegation, tool shell
* **[@dpopsuev/alef-llm](packages/core/llm)**: Unified multi-provider LLM API (Anthropic, OpenAI, Google, …)
* **[@dpopsuev/alef-coding-agent](packages/profiles/coding)**: Coding agent blueprint (fs, shell, code-intel, web, agent, skills)
* **[packages/agent](packages/agent)**: Headless agent server — TUI-as-client, daemon mode, attach/detach

## Attribution

**Alef Agent** is a **fork** of **[Pi](https://github.com/earendil-works/pi-mono)** (the upstream Pi coding agent / terminal harness). Pi was created by **[Mario Zechner](https://mariozechner.at)** ([@badlogic](https://github.com/badlogic)). The upstream open-source tree is **[earendil-works/pi-mono](https://github.com/earendil-works/pi-mono)**.

This fork keeps Mario's design and implementation as its foundation; it adds Alef branding (`@dpopsuev/alef-*` packages, `alef` CLI, `pkg.alef` extensions) and fork-owned defaults (optional version checks and install pings only when you set `ALEF_LATEST_VERSION_URL` / `ALEF_REPORT_INSTALL_URL`). Use the upstream repository for the original project line; use **[dpopsuev/alef](https://github.com/dpopsuev/alef)** for Alef packaging and fork-specific issues.

## Share your OSS coding agent sessions

If you use Pi, Alef, or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## All Packages

| Package | Description |
|---------|-------------|
| **[@dpopsuev/alef-kernel](packages/core/kernel)** | Microkernel — buses, adapter framework, contributions |
| **[@dpopsuev/alef-runtime](packages/core/runtime)** | Agent, AgentController, delegation, tool shell |
| **[@dpopsuev/alef-llm](packages/core/llm)** | Unified multi-provider LLM API (Anthropic, OpenAI, Google, etc.) |
| **[@dpopsuev/alef-session](packages/core/session)** | Session store, turn assembly, context compaction |
| **[@dpopsuev/alef-reasoner](packages/core/reasoner)** | LLM turn loop, tool dispatch, budget signals |
| **[@dpopsuev/alef-tui](packages/ui/tui)** | Terminal UI library with differential rendering |
| **[@dpopsuev/alef-web-ui](packages/ui/web)** | Web components for AI chat interfaces |
| **[@dpopsuev/alef-coding-agent](packages/profiles/coding)** | Coding agent blueprint |
| **[packages/agent](packages/agent)** | Headless agent server + CLI |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for governance (BDFL; read/fork only for outsiders) and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## XDG Directory Structure

Alef follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html):

```
$XDG_CONFIG_HOME/alef/          # User configuration (~/.config/alef)
  ├── theme.yaml                # Custom TUI theme
  ├── config.yaml               # User preferences
  └── skills/                   # User skill library
      └── debug-alef/SKILL.md   # Debug diagnostics skill

$XDG_DATA_HOME/alef/            # User data (~/.local/share/alef)
  ├── sessions/<cwd-hash>/      # Session JSONL logs
  └── prototypes/               # User-written adapter prototypes

$XDG_STATE_HOME/alef/           # Logs & state (~/.local/state/alef)
  ├── debug.log                 # Pino debug trace (rotates at 10MB)
  ├── alef.db                   # SQLite (sessions, events, daemon registry)
  └── last-session.json         # Most recent session metadata

$XDG_CACHE_HOME/alef/           # Cache (~/.cache/alef)
  ├── lsp/                      # TypeScript LSP cache
  ├── embeddings/               # Vector embedding cache
  └── code-intel/<cwd-hash>/    # Regenerable code graph

$XDG_DATA_HOME/alef/forge/<cwd-hash>/  # Local PR sidecar store

<cwd>/agent.yaml                # Optional workspace blueprint
<cwd>/.agents/                  # Project-local agentskills.io layout
  ├── directives/               # Project-specific system prompts
  └── skills/                   # Project-specific skills
```

### Setup XDG Directories

```bash
make xdg-setup    # Create all XDG directories and migrate legacy ~/.alef
make xdg-info     # Show current XDG paths and status
```

## Development

```bash
pnpm install         # Install all dependencies
npm run check:fast   # Lint, format, and type check (pre-commit)
npm run check        # Full check including unit tests (CI)
./alef-test.sh       # Run alef from sources
```

## Debug Mode

Run Alef with comprehensive debugging:

```bash
make debug           # Run with debug logging, auto-load debug-alef skill
make debug-watch     # Watch debug.log in real-time (requires jq)
make debug-errors    # Show only errors from debug.log
make debug-tools     # Show tool execution timing
make debug-clean     # Clear debug.log and session files
```

Debug logs are written to `$XDG_STATE_HOME/alef/debug.log` (typically `~/.local/state/alef/debug.log`).

Watch logs live:
```bash
tail -f ~/.local/state/alef/debug.log | jq .
```

## License

MIT

### Timeout Configuration

Alef's default LLM timeout is **90 seconds** (increased from 60s to accommodate Claude Sonnet 4-5 thinking mode). Override per session:

```bash
# Increase timeout to 3 minutes for complex analysis
ALEF_LLM_TIMEOUT_MS=180000 alef

# Debug mode uses 2 minutes by default
make debug
```
