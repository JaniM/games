/** Close codes the server gives (see `socket.rs`). */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_NOT_FOUND = 4404;

/** The `readyState` of an open WebSocket. Spelled out so tests need no `WebSocket` global to read it. */
export const SOCKET_OPEN = 1;

/** Same origin as the page, so the dev server's proxy and a production reverse proxy both apply. */
export function socketUrl(gameId: string): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/api/games/${gameId}/ws`;
}

/**
 * How long to wait before the next connection attempt, given how many attempts in a
 * row have failed to get a snapshot: 1s, 2s, 4s, 8s, then 10s.
 */
export function backoffMs(failures: number): number {
  return Math.min(1000 * 2 ** failures, 10_000);
}
