<p align="center">
  <a href="https://github.com/dpopsuev/alf-agent"><strong>Alf Agent</strong></a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@alf-agent/coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@alf-agent/coding-agent?style=flat-square" /></a>
</p>

> This fork is maintained BDFL-style; outside contributions are not accepted. Source is open to read and to fork (MIT). See [CONTRIBUTING.md](../../CONTRIBUTING.md).

---

## Attribution

**Alf** (`alf`, npm **`@alf-agent/coding-agent`**) is a **fork** of **[Pi](https://github.com/earendil-works/pi-mono)** (**Pi Agent** / terminal coding harness). Pi was created by **[Mario Zechner](https://mariozechner.at)** ([@badlogic](https://github.com/badlogic)); upstream sources live in **[earendil-works/pi-mono](https://github.com/earendil-works/pi-mono)**. The MIT-licensed implementation here builds on that work—credit for the original belongs to Mario and the Pi contributors.

**Alf** is maintained separately in **[dpopsuev/alf-agent](https://github.com/dpopsuev/alf-agent)** with Alf-specific scopes and defaults; behavior below follows Pi unless noted otherwise.

---

**Alf** is a minimal terminal coding harness. Adapt Alf to your workflows, not the other way around, without having to fork and modify core internals. Extend it with TypeScript [Extensions](#extensions), [Skills](#skills), [Prompt Templates](#prompt-templates), and [Themes](#themes). Put your extensions, skills, prompt templates, and themes in [Alf packages](#alf-packages) and share them with others via npm or git.

Alf ships with powerful defaults but skips features like sub agents and plan mode. Instead, you can ask Alf to build what you want or install a third-party package that matches your workflow.

Alf runs in four modes: interactive, print or JSON, RPC for process integration, and an SDK for embedding in your own apps. See [openclaw/openclaw](https://github.com/openclaw/openclaw) for a real-world SDK integration.

## Share your OSS coding agent sessions

If you use Alf or Pi for open source work, please share your coding agent sessions.

Public OSS session data helps improve models, prompts, tools, and evaluations using real development workflows.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Alf packages](#alf-packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)

---

## Quick Start

Install the CLI globally via npm:

```bash
npm install -g @alf-agent/coding-agent
```

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
alf
```

Or use your existing subscription:

```bash
alf
/login  # Then select provider
```

Then just talk to Alf. By default, Alf exposes four tools to the model: `read`, `write`, `edit`, and `bash`. The model uses these to fulfill your requests. Add capabilities via [skills](#skills), [prompt templates](#prompt-templates), [extensions](#extensions), or [Alf packages](#alf-packages).

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

## Providers & Models

For each built-in provider, Alf ships a list of tool-capable models, updated with every release. Authenticate via subscription (`/login`) or API key, then select any model from that provider via `/model` (or Ctrl+L).

**Subscriptions:**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot

**API keys:**
- Anthropic
- OpenAI
- Azure OpenAI
- DeepSeek
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Together AI
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan (China)
- Xiaomi MiMo Token Plan (Amsterdam)
- Xiaomi MiMo Token Plan (Singapore)

See [docs/providers.md](docs/providers.md) for detailed setup instructions.

**Custom providers & models:** Add providers via `<agent-dir>/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface from top to bottom:

- **Startup header** - Shows shortcuts (`/hotkeys` for all), loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type; border color indicates thinking level
- **Footer** - Working directory, session name, total token/cache usage, cost, context usage, current model

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| Images | Ctrl+V to paste (Alt+V on Windows), or drag onto terminal |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | OAuth authentication |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session info (file, ID, messages, tokens, cost) |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files (themes hot-reload automatically) |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit alf |

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `<agent-dir>/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel/abort |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Shift+Tab | Cycle thinking level |
| Ctrl+O | Collapse/expand tool output |
| Ctrl+T | Collapse/expand thinking blocks |

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Escape** aborts and restores queued messages to editor
- **Alt+Up** retrieves queued messages back to editor

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so Alf can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

---

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session-format.md](docs/session-format.md) for file format.

### Management

Sessions auto-save to `<agent-dir>/sessions/` organized by working directory.

```bash
alf -c                  # Continue most recent session
alf -r                  # Browse and select from past sessions
alf --no-session        # Ephemeral mode (don't save)
alf --session <path|id> # Use specific session file or ID
alf --fork <path|id>    # Fork specific session file or ID into a new session
```

Use `/session` in interactive mode to see the current session ID before reusing it with `--session <id>` or `--fork <id>`.

### Branching

**`/tree`** - Navigate the session tree in-place. Select any previous point, continue from there, and switch between branches. All history preserved in a single file.

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- Search by typing, fold/unfold and jump between branches with Ctrl+←/Ctrl+→ or Alt+←/Alt+→, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press Shift+L to label entries as bookmarks and Shift+T to toggle label timestamps

**`/fork`** - Create a new session file from a previous user message on the active branch. Opens a selector, copies the active path up to that point, and places the selected prompt in the editor for modification.

**`/clone`** - Duplicate the current active branch into a new session file at the current position. The new session keeps the full active-path history and opens with an empty editor.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy. The full history remains in the JSONL file; use `/tree` to revisit. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

---

## Settings

`<agent-dir>` is your global Alf config root (sessions, auth, settings, etc.):

- **Linux:** `$XDG_CONFIG_HOME/alf/agent` (usually `~/.config/alf/agent`). If `~/.alf/agent` already exists, that directory is used instead.
- **macOS and Windows:** `~/.alf/agent`
- **Override:** set `ALF_CODING_AGENT_DIR`

Project-local overrides live under `.alf/` in the repo root (for example `.alf/settings.json`).

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `<agent-dir>/settings.json` | Global (all projects) |
| `.alf/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

### Telemetry and update checks

Alf does **not** call third-party homepages by default.

- **Update check:** runs only when **`ALF_LATEST_VERSION_URL`** is set to an HTTPS URL that returns JSON like `{ "version": "1.2.3" }`. Otherwise no request is made. Set **`ALF_SKIP_VERSION_CHECK=1`** to skip even when a URL is configured.
- **Install/update telemetry:** sends a GET only when **`ALF_REPORT_INSTALL_URL`** is set **and** install telemetry is enabled (`enableInstallTelemetry` in settings, default on, overridable with **`ALF_TELEMETRY`**).

Use **`--offline`** or **`ALF_OFFLINE=1`** to disable startup checks that hit the network (including package update checks that talk to registries).

---

## Context Files

Alf loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `<agent-dir>/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

Use for project instructions, conventions, common commands. All matching files are concatenated.

Disable context file loading with `--no-context-files` (or `-nc`).

### System Prompt

Replace the default system prompt with `.alf/SYSTEM.md` (project) or `<agent-dir>/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- <agent-dir>/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `<agent-dir>/prompts/`, `.alf/prompts/`, or an [Alf package](#alf-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke via `/skill:name` or let the agent load them automatically.

```markdown
<!-- <agent-dir>/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Place in `<agent-dir>/skills/`, `~/.agents/skills/`, `.alf/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or an [Alf package](#alf-packages) to share with others. See [docs/skills.md](docs/skills.md).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend Alf with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
export default function (alf: ExtensionAPI) {
  alf.registerTool({ name: "deploy", ... });
  alf.registerCommand("stats", { ... });
  alf.on("tool_call", async (event, ctx) => { ... });
}
```

The default export can also be `async`. Alf waits for async extension factories before startup continues, which is useful for one-time initialization such as fetching remote model lists before calling `alf.registerProvider()`.

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Sub-agents and plan mode
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and auto-commit
- SSH and sandbox execution
- MCP server integration
- Make Alf look like Claude Code
- Games while waiting (yes, Doom runs)
- ...anything you can dream up

Place in `<agent-dir>/extensions/`, `.alf/extensions/`, or an [Alf package](#alf-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and Alf applies changes immediately.

Place in `<agent-dir>/themes/`, `.alf/themes/`, or an [Alf package](#alf-packages) to share with others. See [docs/themes.md](docs/themes.md).

### Alf packages

Bundle and share extensions, skills, prompts, and themes via npm or git. Find packages on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Aalf-package) or upstream-compatible listings tagged [`pi-package`](https://www.npmjs.com/search?q=keywords%3Api-package), or ask on [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628).

> **Security:** Packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
alf install npm:@foo/alf-tools
alf install npm:@foo/alf-tools@1.2.3      # pinned version
alf install git:github.com/user/repo
alf install git:github.com/user/repo@v1  # tag or commit
alf install git:git@github.com:user/repo
alf install git:git@github.com:user/repo@v1  # tag or commit
alf install https://github.com/user/repo
alf install https://github.com/user/repo@v1      # tag or commit
alf install ssh://git@github.com/user/repo
alf install ssh://git@github.com/user/repo@v1    # tag or commit
alf remove npm:@foo/alf-tools
alf uninstall npm:@foo/alf-tools          # alias for remove
alf list
alf update                               # update Alf and packages (skips pinned packages)
alf update --extensions                  # update packages only
alf update --self                        # update Alf only
alf update --self --force                # reinstall Alf even if current
alf update npm:@foo/alf-tools             # update one package
alf config                               # enable/disable extensions, skills, prompts, themes
```

Packages install to `<agent-dir>/git/` (git) or global npm. Use `-l` for project-local installs (`.alf/git/`, `.alf/npm/`). Git packages install dependencies with `npm install --omit=dev` by default, so runtime deps must be listed under `dependencies`; when `npmCommand` is configured, git packages use plain `install` for compatibility with wrappers. If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding an `alf` key to `package.json`:

```json
{
  "name": "my-alf-package",
  "keywords": ["alf-package"],
  "alf": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without an `alf` manifest, Alf auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@alf-agent/coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

await session.prompt("What files are in the current directory?");
```

For advanced multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
alf --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## Philosophy

Pi upstream design is aggressively extensible so core workflows stay minimal; Alf inherits that. Features other tools bake in can be built with [extensions](#extensions), [skills](#skills), or installed from third-party [Alf packages](#alf-packages). This keeps the core small while letting you shape Alf to fit how you work.

**No MCP.** Build CLI tools with READMEs (see [Skills](#skills)), or build an extension that adds MCP support. [Why?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**No sub-agents.** There's many ways to do this. Spawn Alf instances via tmux, or build your own with [extensions](#extensions), or install a package that does it your way.

**No permission popups.** Run in a container, or build your own confirmation flow with [extensions](#extensions) inline with your environment and security requirements.

**No plan mode.** Write plans to files, or build it with [extensions](#extensions), or install a package.

**No built-in to-dos.** They confuse models. Use a TODO.md file, or build your own with [extensions](#extensions).

**No background bash.** Use tmux. Full observability, direct interaction.

Read the [blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) for the full rationale.

---

## CLI Reference

```bash
alf [options] [@files...] [messages...]
```

### Package Commands

```bash
alf install <source> [-l]     # Install package, -l for project-local
alf remove <source> [-l]      # Remove package
alf uninstall <source> [-l]   # Alias for remove
alf update [source|self|alf]   # Update Alf and packages (skips pinned packages)
alf update --extensions       # Update packages only
alf update --self             # Update Alf only
alf update --self --force     # Reinstall Alf even if current
alf update --extension <src>  # Update one package
alf list                      # List installed packages
alf config                    # Enable/disable package resources
```

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export session to HTML |

In print mode, Alf also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | alf -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume` | Browse and select session |
| `--session <path\|id>` | Use specific session file or partial UUID |
| `--fork <path\|id>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific tool names across built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools by default but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools by default |

Available built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable AGENTS.md and CLAUDE.md context file discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

```bash
alf @prompt.md "Answer this"
alf -p @screenshot.png "What's in this image?"
alf @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
alf "List all .ts files in src/"

# Non-interactive
alf -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | alf -p "Summarize this text"

# Different model
alf --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix (no --provider needed)
alf --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
alf --model sonnet:high "Solve this complex problem"

# Limit model cycling
alf --models "claude-*,gpt-4o"

# Read-only mode
alf --tools read,grep,find,ls -p "Review the code"

# High thinking level
alf --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ALF_CODING_AGENT_DIR` | Override `<agent-dir>` (see [Settings](#settings)) |
| `ALF_CODING_AGENT_SESSION_DIR` | Override session storage directory (overridden by `--session-dir`) |
| `ALF_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `ALF_OFFLINE` | Disable startup network operations, including update checks, package update checks, and install/update telemetry |
| `ALF_SKIP_VERSION_CHECK` | Skip the optional latest-version fetch when `ALF_LATEST_VERSION_URL` is set |
| `ALF_LATEST_VERSION_URL` | When set, JSON endpoint for update checks (`version` field required). Unset = no update request |
| `ALF_REPORT_INSTALL_URL` | When set, anonymous install/update ping target. Unset = no telemetry request |
| `ALF_TELEMETRY` | Override install/update telemetry. Use `1`/`true`/`yes` to enable or `0`/`false`/`no` to disable. This does not disable update checks |
| `ALF_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

---

## Contributing & Development

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for governance (BDFL; read/fork) and [docs/development.md](docs/development.md) for setup, forking, and debugging.

---

## License

MIT

## See Also

- [@alf-agent/ai](https://www.npmjs.com/package/@alf-agent/ai): Core LLM toolkit
- [@alf-agent/agent-core](https://www.npmjs.com/package/@alf-agent/agent-core): Agent framework
- [@alf-agent/tui](https://www.npmjs.com/package/@alf-agent/tui): Terminal UI components
