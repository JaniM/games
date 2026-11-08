# Jailed Claude Code

Runs Claude Code in this checkout with access to the project and little else. It is packaged in `flake.nix` and enforced by [sandbox-runtime](https://github.com/anthropics/sandbox-runtime), which uses Seatbelt on macOS and bubblewrap on Linux. The rules are in `srt-settings.json`.

## Setup

Create a token. It can only make model requests, so claude.ai connectors stay out of the jail:

```bash
claude setup-token
mkdir -p ~/.config/games-sandbox
(umask 077 && pbpaste > ~/.config/games-sandbox/claude-token)   # after copying the token
```

## Use

```bash
nix develop
jailed-claude                       # from the repo root; arguments go to claude
JAILED_COMMAND=bash jailed-claude   # a shell inside the jail, for debugging
```

Jail state, including its cargo target directory and its own copy of Claude's auto-memory, is in `~/.local/state/games-sandbox`. That copy doesn't sync with your real memory in either direction.

## What Claude can touch

| Paths | Access |
|---|---|
| Project files | Read and write |
| `.git`, `.jj`, `.claude`, `CLAUDE.md`, `flake.nix`, `flake.lock`, `sandbox/` | Read-only |
| Every `node_modules` and `target` directory | Read-only |
| `.env`, `.env.*` | Hidden |
| Everything else under `/Users`, `/Volumes`, `/private/tmp` and `/private/var/folders` | Hidden |
| Network | Only the hosts in `srt-settings.json` |

Claude can't commit, so review and commit with jj on the Mac. It also can't change npm dependencies: when `pnpm` reports that they are out of date, run `pnpm install` on the Mac. Cargo can fetch crates, so Rust dependencies can change inside the jail.

## Limits

- **Code that Claude writes still runs on your Mac** when you run the app, tests or build scripts yourself. Check the diff first, especially `vite.config.ts`, `package.json` scripts and `build.rs`.
- **Local services are reachable.** Tests need loopback, so Claude can connect to anything listening on localhost. That includes Postgres, Docker-published ports and any SSH tunnel, so close tunnels before a long session.
- **Files outside the hidden paths stay readable**, such as `/etc`, `/Applications` and `/nix/store`.
- **Allowed hosts can carry data out**, so add new ones sparingly.
- **`dist` and other build output are writable**, and those changes don't appear in `jj diff`.
- **The `node_modules` and `target` rules are globs**, which bubblewrap doesn't support, so on Linux they protect nothing.
- **There is no VM.** This is a kernel sandbox on the same macOS, so it is weaker than a microVM.

Don't point Nix at this repo with `path:.`. That copies the whole directory, including `.env`, into the world-readable Nix store. Plain `nix develop` copies only git-tracked files.
