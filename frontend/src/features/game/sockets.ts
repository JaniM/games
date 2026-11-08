/**
 * The WebSocket of each open game, by game id.
 *
 * An effect task can read the db and write through ops, but it can't see what another
 * task holds. The task that owns a game's socket lists it here, so that `sendActions`
 * can use it. An entry lives exactly as long as its socket: the owner removes it when
 * the socket closes.
 */
const sockets = new Map<string, WebSocket>();

export function registerSocket(gameId: string, socket: WebSocket): void {
  sockets.set(gameId, socket);
}

/** Forgets `socket`, unless a newer one has taken its place. */
export function unregisterSocket(gameId: string, socket: WebSocket): void {
  if (sockets.get(gameId) === socket) sockets.delete(gameId);
}

/** The game's socket, if it has one. It may not be open yet. */
export function socketOf(gameId: string): WebSocket | undefined {
  return sockets.get(gameId);
}
