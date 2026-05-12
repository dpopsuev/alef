# Alef Agent documentation

Alef is a minimal terminal coding harness. It stays small at the core while being extended through TypeScript extensions, skills, prompt templates, themes, and Alef packages.

## Quick start

Install globally via npm:

```bash
npm install -g @dpopsuev/alef-coding-agent
```

Then run it in a project directory:

```bash
alef
```

Authenticate with `:login` for subscription providers, or set an API key such as `ANTHROPIC_API_KEY` before starting Alef.

## Guides

- [Quickstart](quickstart.md) — first session and basics
- [Usage](usage.md) — CLI modes and flags
- [Providers](providers.md) — auth and provider setup
- [Models](models.md) — custom models (`models.json`)
- [Custom providers](custom-provider.md)
- [Settings](settings.md)
- [Keybindings](keybindings.md)
- [Sessions](sessions.md)
- [Session format](session-format.md)
- [Compaction](compaction.md)

## Customization

- [Extensions](extensions.md)
- [Skills](skills.md)
- [Prompt templates](prompt-templates.md)
- [Themes](themes.md)
- [Alef packages](packages.md)

## Platforms and tooling

- [Windows](windows.md)
- [Termux](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## Programmatic use

- [SDK](sdk.md) — embed Alef from Node.js
- [RPC](rpc.md) — JSONL protocol over stdio
- [JSON mode](json.md) — machine-readable events
- [TUI internals](tui.md)

## Development

- [Development](development.md) — build and hack on this repo
