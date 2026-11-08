import type { Snapshot, Step } from "./schemas";

/** The seat `userId` has in the game, or null for someone who is only watching. */
export function seatOf(snapshot: Pick<Snapshot, "players">, userId: string | null): 0 | 1 | null {
  if (userId === null) return null;
  const seat = snapshot.players.indexOf(userId);
  return seat === 0 || seat === 1 ? seat : null;
}

/** Where a step of the player to move ends, as they count: a point, or off the board. */
export type Landing = number | "off";

export function landing(step: Step): Landing {
  const to = step.from + step.die;
  return to >= 25 ? "off" : to;
}

/** Both seats are taken. */
export function isFull(snapshot: Pick<Snapshot, "players">): boolean {
  return snapshot.players.length >= 2;
}
