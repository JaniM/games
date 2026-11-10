import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
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
  },
});
