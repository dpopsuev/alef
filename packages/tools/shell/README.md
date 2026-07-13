# @dpopsuev/alef-tool-shell

Shell tool for command execution via the Alef bus (`shell.exec`).

## Surface

- `createShellAdapter` — streaming spawn (default) or persistent PTY (`usePty`)
- `getShellConfig` / `getShellEnv` — shell binary discovery and PATH helpers
- `guardCommand` — command blocklist
- `killProcessTree` — process-group / Windows tree kill used on hard timeout escalation

## Not included

One-shot platform spawn adapters (`PosixShellAdapter` / `WindowsShellAdapter`) were removed;
execution lives entirely in the bus adapter path.
