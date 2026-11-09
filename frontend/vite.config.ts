import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Vite caches into node_modules, which is read-only in the jail (see CLAUDE.md).
  // Keep the host on the default: a cache the jail can write is code the host would run.
  cacheDir: process.env.GAMES_SANDBOX ? `${process.env.HOME}/vite-cache` : undefined,
  server: {
    // Vite refuses requests whose Host header it doesn't know, as a guard against DNS
    // rebinding. `localhost` and IP addresses are always fine; a name that reaches this
    // machine from another device (`pnpm dev:lan`) has to be listed. A leading dot allows
    // the domain and all its subdomains: here, every Tailscale name.
    allowedHosts: [".ts.net", ".trycloudflare.com"],
    // The axum backend (compose.yaml publishes it on 3000).
    // `ws` lets the game sockets (/api/games/<id>/ws) through.
    proxy: { "/api": { target: "http://127.0.0.1:3000", ws: true } },
  },
  test: {
    environment: "node",
    // Vitest's module cache also lives in node_modules (`.vitest-cache`), and it deletes
    // its entries whenever the lockfile changes, which the jail can't do. Same reasoning
    // as `cacheDir` above: only the jail moves it.
    fsModuleCachePath: process.env.GAMES_SANDBOX ? `${process.env.HOME}/vitest-cache` : undefined,
  },
});
