<p align="center">
  <a href="https://github.com/dpopsuev/alf-agent"><strong>Alf Agent</strong></a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
</p>

> This fork is maintained BDFL-style; outside contributions are not accepted. Source is open to read and to fork (MIT). See [CONTRIBUTING.md](CONTRIBUTING.md).

---

# Alf Agent Harness Monorepo

This repository contains the Alf coding agent CLI and supporting packages.

* **[@alf-agent/coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@alf-agent/agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@alf-agent/ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

## Attribution

**Alf Agent** is a **fork** of **[Pi](https://github.com/earendil-works/pi-mono)** (the upstream Pi coding agent / terminal harness). Pi was created by **[Mario Zechner](https://mariozechner.at)** ([@badlogic](https://github.com/badlogic)). The upstream open-source tree is **[earendil-works/pi-mono](https://github.com/earendil-works/pi-mono)**.

This fork keeps Mario’s design and implementation as its foundation; it adds Alf branding (`@alf-agent/*` packages, `alf` CLI, `pkg.alf` extensions) and fork-owned defaults (optional version checks and install pings only when you set `ALF_LATEST_VERSION_URL` / `ALF_REPORT_INSTALL_URL`). Use the upstream repository for the original project line; use **[dpopsuev/alf-agent](https://github.com/dpopsuev/alf-agent)** for Alf packaging and fork-specific issues.

## Share your OSS coding agent sessions

If you use Pi, Alf, or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## All Packages

| Package | Description |
|---------|-------------|
| **[@alf-agent/ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@alf-agent/agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@alf-agent/coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@alf-agent/tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@alf-agent/web-ui](packages/web-ui)** | Web components for AI chat interfaces |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for governance (BDFL; read/fork only for outsiders) and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./alf-test.sh        # Run alf from sources
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License

MIT
