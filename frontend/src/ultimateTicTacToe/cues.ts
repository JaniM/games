import { useState } from "react";
import type { Seat, UtttState } from "../features/game";
import type { TimedCue } from "../longBackgammon/cues";

// Which sounds go with what just happened on the board, and how it is noticed that a mark was
// just placed. The sounds are the ones long backgammon's synthesizer makes (see
// `longBackgammon/sounds`): a mark is the click of a checker landing.

/** The mark that was just placed: where, and by whom. */
export type Placed = NonNullable<UtttState["last"]>;

/** The pause between the last mark and the jingle that ends the game. */
const BEFORE_RESULT_MS = 250;

/** How many cells are marked. */
function marksIn(state: UtttState): number {
  return state.cells.reduce((count, cell) => count + cell.filter((seat) => seat !== null).length, 0);
}

/**
 * The mark that led from `before` to `after`, if the eye can follow it: it is the one mark that
 * `after` has more. A change that can't be followed (the first position, a reconnect that missed
 * some marks, stepping back through a review) is no mark that was just placed.
 */
export function placedBetween(before: UtttState | null, after: UtttState | null): Placed | null {
  if (!before || !after?.last) return null;
  if (marksIn(after) !== marksIn(before) + 1) return null;
  const { board, cell } = after.last;
  return before.cells[board]?.[cell] === null ? after.last : null;
}

export interface Change {
  /** The mark that led to the position shown, if it can be followed. */
  placed: Placed | null;
  /** The game has just ended: the position shown is over, the one before was not. */
  ended: boolean;
  state: UtttState | null;
  /** The seat the board is drawn for. */
  viewer: Seat;
  /** The viewer plays in this game, rather than watches it. A spectator hears no win or loss. */
  player: boolean;
}

/** The sounds for a new position, in the order they sound. A position that wasn't followed makes none. */
export function cuesFor({ placed, ended, state, viewer, player }: Change): TimedCue[] {
  const cues: TimedCue[] = [];
  if (placed) cues.push({ cue: "move", afterMs: 0 });
  if (ended && state?.phase.type === "over") {
    const { winner } = state.phase;
    const result = !player || winner === null ? "end" : winner === viewer ? "win" : "lose";
    cues.push({ cue: result, afterMs: BEFORE_RESULT_MS });
  }
  return cues;
}

export interface Held {
  revision: number;
  state: UtttState | null;
  placed: Placed | null;
  ended: boolean;
}

/**
 * What is held once the board is given `state` at `revision`: the same object if the revision
 * is not new, else what led from the position held to this one.
 */
export function advance(held: Held, state: UtttState | null, revision: number): Held {
  if (held.revision === revision) return held;
  // Only a game seen to end counts: one that is already over when the board opens ended long ago.
  const ended = held.state !== null && held.state.phase.type !== "over" && state?.phase.type === "over";
  return { revision, state, placed: placedBetween(held.state, state), ended };
}

/**
 * What just happened on the board, worked out each time the revision changes: the mark placed,
 * which the drawing gives its short animation, and whether the game was seen to end. Only a new
 * revision counts: the same one again is the same position with new labels, and must not run the
 * animation again.
 */
export function useHeld(state: UtttState | null, revision: number): Held {
  const [held, setHeld] = useState<Held>({ revision, state, placed: null, ended: false });
  const current = advance(held, state, revision);
  // Set while rendering, so that the first paint of the new position already knows its mark.
  if (current !== held) setHeld(current);
  return current;
}
