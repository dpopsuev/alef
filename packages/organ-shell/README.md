# @dpopsuev/alef-organ-shell

Shell organ runtime primitives for command execution.

This package provides:

- shell process execution adapters (`PosixShellAdapter`, `WindowsShellAdapter`)
- shell discovery/config (`getShellConfig`)
- process lifecycle helpers (`waitForChildProcess`, process tree termination)
- detached shell process tracking hooks for host shutdown cleanup
