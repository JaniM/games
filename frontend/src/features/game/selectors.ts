import type { Snapshot } from "./schemas";

/** The seat `userId` has in the game, or null for someone who is only watching. */
export function seatOf(snapshot: Pick<Snapshot, "players">, userId: string | null): 0 | 1 | null {
  if (userId === null) return null;
  const seat = snapshot.players.indexOf(userId);
  return seat === 0 || seat === 1 ? seat : null;
}

/** Both seats are taken. */
export function isFull(snapshot: Pick<Snapshot, "players">): boolean {
  return snapshot.players.length >= 2;
}
