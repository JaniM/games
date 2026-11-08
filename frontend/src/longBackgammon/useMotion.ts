import { useState } from "react";
import type { LongBackgammonState, Seat } from "../features/game";
import { type Motion, motionBetween } from "./motion";

export interface Held {
  revision: number;
  state: LongBackgammonState | null;
  motion: Motion | null;
  rolls: number;
  ended: boolean;
}

/**
 * What is held once the board is given `state` at `revision`: the same object if the
 * revision is not new, else the event that led from the position held to this one.
 */
export function advance(
  held: Held,
  state: LongBackgammonState | null,
  revision: number,
  viewer: Seat,
): Held {
  if (held.revision === revision) return held;
  const motion = motionBetween(held.state, state, viewer);
  // Only a game seen to end counts: one that is already over when the board opens ended long
  // ago. A jump over several moves (a reconnect) still shows the end it lands on.
  const ended = held.state !== null && held.state.phase.type !== "over" && state?.phase.type === "over";
  return { revision, state, motion, rolls: held.rolls + (motion?.type === "roll" ? 1 : 0), ended };
}

/**
 * What just happened on the board, worked out each time the server's revision changes.
 *
 * - `motion` is the event that led to the position shown now, until the next change.
 *   Nothing is "playing": the drawing runs the animations itself, and keys them by the
 *   revision so that a new event starts a new one.
 * - `rolls` counts the rolls seen since the board appeared. It is 0 on a board that
 *   opens in the middle of a game, whose dice should lie still.
 * - `ended` is true for the one position in which the game was seen to end.
 *
 * Only a new revision counts. The same one again is the same position with new labels (a
 * player renamed themselves, or the socket came back) and must not cut an animation short.
 */
export function useMotion(
  state: LongBackgammonState | null,
  revision: number,
  viewer: Seat,
): { motion: Motion | null; rolls: number; ended: boolean } {
  const [held, setHeld] = useState<Held>({ revision, state, motion: null, rolls: 0, ended: false });
  const current = advance(held, state, revision, viewer);
  // Set while rendering, so that the first paint of the new position already has its motion.
  if (current !== held) setHeld(current);
  return current;
}
