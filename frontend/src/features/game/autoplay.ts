import type { Action, Snapshot } from "./schemas";
import { seatOf } from "./selectors";

/**
 * How long auto-play waits before each action. Long enough for the dice to settle and the
 * last checker to land, so that what it plays can be followed on the board.
 */
export const AUTOPLAY_PAUSE_MS = 800;

/** The mover's own point 1, where all 15 checkers start. */
const HEAD = 1;

/**
 * What auto-play does now: roll when it is time to roll, else play a step. It takes a checker
 * off the head whenever a legal step from the head exists, as the opening of long backgammon
 * calls for; among the steps it may choose from (the ones off the head, else all of them)
 * every one is equally likely. Null when there is nothing for `userId` to do: it is not their
 * turn, or the game has not started or is over.
 *
 * It picks only from what the server offers, so it needs no rules of its own. A turn in which
 * nothing can be played never reaches it: the server ends such a turn itself.
 *
 * `random` returns a number from 0 up to, not including, 1, like `Math.random`.
 */
export function autoplayAction(
  snapshot: Snapshot,
  userId: string | null,
  random: () => number = Math.random,
): Action | null {
  const state = snapshot.state;
  if (!state || seatOf(snapshot, userId) !== state.turn) return null;
  if (state.phase.type === "roll") return { type: "roll" };
  if (state.phase.type !== "move") return null;

  const fromHead = state.legal.filter((step) => step.from === HEAD);
  const choices = fromHead.length > 0 ? fromHead : state.legal;
  const step = choices[Math.floor(random() * choices.length)];
  return step ? { type: "move", from: step.from, die: step.die } : null;
}
