# Development

See [AGENTS.md](../../../AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/earendil-works/pi-mono
cd pi-mono
npm install
npm run build
```

Run from source:

```bash
/path/to/your-repo/alf-test.sh
# Legacy alias: ./pi-test.sh
```

The script can be run from any directory. The CLI keeps the caller's current working directory.

## Forking / Rebranding

Configure via `package.json` (see `packages/coding-agent/package.json` in this fork):

```json
{
  "piConfig": {
    "name": "alf",
    "configDir": ".alf"
  },
  "bin": {
    "alf": "dist/cli.js"
  }
}
```

Change `name`, `configDir`, and `bin` for your fork. Affects CLI banner, project-local config folder name (e.g. `.alf`), and env names (`ALF_CODING_AGENT_DIR`, etc.; `ALF_CODING_AGENT_DIR` still works).

On **Linux**, the default **user** agent directory follows **XDG**: `$XDG_CONFIG_HOME/<name>/agent` (usually `~/.config/alf/agent`). If `~/.alf/agent` already exists, that legacy path is kept until you move it.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.pi/agent/pi-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
