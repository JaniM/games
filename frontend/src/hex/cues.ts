import { useState } from "react";
import type { HexState, Seat } from "../features/game";
import { stoneAt } from "../features/game/hex";
import type { TimedCue } from "../longBackgammon/cues";

// Which sounds go with what just happened on the board, and how it is noticed that a stone was just
// placed. The sounds are the ones long backgammon's synthesizer makes (see `longBackgammon/sounds`):
// a stone is the click of a checker landing, as a mark of ultimate tic-tac-toe is.

/** The move that was just made: the stone it placed, and whether it was the swap. */
export type Placed = NonNullable<HexState["last"]>;

/** The pause between the last stone and the jingle that ends the game. */
const BEFORE_RESULT_MS = 250;

/** How many stones are on the board. */
function stonesIn(state: HexState): number {
  return state.cells.filter((seat) => seat !== null).length;
}

/**
 * The move that led from `before` to `after`, if the eye can follow it: one stone more, on a cell
 * that was empty, or the swap, which takes Red's stone away and puts Blue's in its mirror. A change
 * that can't be followed (the first position, a reconnect that missed some moves, stepping back
 * through a review) is no move that was just made.
 */
export function placedBetween(before: HexState | null, after: HexState | null): Placed | null {
  if (!before || !after?.last) return null;
  const { column, row, swap } = after.last;
  if (swap) return !before.swapped && stonesIn(before) === 1 ? after.last : null;
  if (stonesIn(after) !== stonesIn(before) + 1) return null;
  return stoneAt(before, column, row) === null ? after.last : null;
}

export interface Change {
  /** The move that led to the position shown, if it can be followed. */
  placed: Placed | null;
  /** The game has just ended: the position shown is over, the one before was not. */
  ended: boolean;
  state: HexState | null;
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
    const result = !player ? "end" : winner === viewer ? "win" : "lose";
    cues.push({ cue: result, afterMs: BEFORE_RESULT_MS });
  }
  return cues;
}

export interface Held {
  revision: number;
  state: HexState | null;
  placed: Placed | null;
  ended: boolean;
}

/**
 * What is held once the board is given `state` at `revision`: the same object if the revision is
 * not new, else what led from the position held to this one.
 */
export function advance(held: Held, state: HexState | null, revision: number): Held {
  if (held.revision === revision) return held;
  // Only a game seen to end counts: one that is already over when the board opens ended long ago.
  const ended = held.state !== null && held.state.phase.type !== "over" && state?.phase.type === "over";
  return { revision, state, placed: placedBetween(held.state, state), ended };
}

/**
 * What just happened on the board, worked out each time the revision changes: the stone placed,
 * which the drawing sets down with a short animation, and whether the game was seen to end. Only a
 * new revision counts: the same one again is the same position with new labels, and must not run
 * the animation again.
 */
export function useHeld(state: HexState | null, revision: number): Held {
  const [held, setHeld] = useState<Held>({ revision, state, placed: null, ended: false });
  const current = advance(held, state, revision);
  // Set while rendering, so that the first paint of the new position already knows its stone.
  if (current !== held) setHeld(current);
  return current;
}
