import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Vite caches into node_modules, which is read-only in the jail (see CLAUDE.md).
  // Keep the host on the default: a cache the jail can write is code the host would run.
  cacheDir: process.env.GAMES_SANDBOX ? `${process.env.HOME}/vite-cache` : undefined,
  server: {
    // The axum backend (compose.yaml publishes it on 3000).
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
  test: { environment: "node" },
});
