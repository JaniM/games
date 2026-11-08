# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A board game website with a Rust backend and a React frontend.

Game rules live in `docs/games/<game>.md`. Follow them exactly and ask before deviating. Start with `docs/games/long-backgammon.md`.

## Sandbox

If `GAMES_SANDBOX=1` is set, you are in the jail from `sandbox/README.md`. `.git`, `.jj`, `node_modules` and `target` are read-only, so don't commit (the user does, with jj) and ask the user to run `pnpm install` when npm dependencies change. `jj` isn't available; use `git` to read history. Cargo builds into `$CARGO_TARGET_DIR` in the jail's home.

Vite writes into `node_modules` by default, so it needs two settings to run in the jail:

- `` cacheDir: process.env.GAMES_SANDBOX ? `${process.env.HOME}/vite-cache` : undefined `` in `vite.config.ts`. Keep the host on the default: a cache the jail can write is code the host would run.
- `--configLoader runner` on every `vite` and `vitest` command in `package.json`. The default loader bundles the config into `node_modules/.vite-temp`.

## Commands

```bash
# Dev shell with pinned Rust, Node, pnpm, sqlx-cli and psql
nix develop

# Claude Code in a jail (sandbox/README.md)
jailed-claude
```
