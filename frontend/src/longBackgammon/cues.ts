import type { LongBackgammonState, Seat } from "../features/game";
import type { Motion } from "./motion";

// Which sounds go with what just happened on the board. Kept apart from the synthesizer
// (see `sounds`) so that what is heard, and when, can be tested without any audio.

/** One sound the game can make. */
export type Cue =
  /** The dice rattle and settle. */
  | "roll"
  /** A checker lands on a point. */
  | "move"
  /** A checker lies down in the tray. */
  | "bearOff"
  /** The game is over and the listener won, lost, or is only watching. */
  | "win"
  | "lose"
  | "end";

/** A cue and how long after the change it sounds. */
export interface TimedCue {
  cue: Cue;
  afterMs: number;
}

// How long the motions take to play, as in `--move-ms` and `--roll-ms` in styles.css. A
// checker is heard where it lands, so its sound waits for the end of the flight.
export const MOVE_MS = 225;
export const ROLL_MS = 450;

/** The pause between the last motion and the jingle that ends the game. */
const BEFORE_RESULT_MS = 250;

export interface Change {
  /** What led to the position shown, if it can be followed (see `motionBetween`). */
  motion: Motion | null;
  /** The game has just ended: the position shown is over, the one before was not. */
  ended: boolean;
  state: LongBackgammonState | null;
  /** The seat the board is drawn for. */
  viewer: Seat;
  /** The viewer plays in this game, rather than watches it. A spectator hears no win or loss. */
  player: boolean;
}

/**
 * The sounds for a new position, in the order they sound. A change that cannot be followed
 * with the eye (the first position, a reconnect that missed some moves) makes no sound, as
 * it shows no motion.
 */
export function cuesFor({ motion, ended, state, viewer, player }: Change): TimedCue[] {
  const cues: TimedCue[] = [];
  let busyUntil = 0;

  if (motion?.type === "roll") {
    cues.push({ cue: "roll", afterMs: 0 });
    busyUntil = ROLL_MS;
  } else if (motion?.type === "move") {
    cues.push({ cue: motion.to.at === "off" ? "bearOff" : "move", afterMs: MOVE_MS });
    busyUntil = MOVE_MS;
  }

  if (ended && state?.phase.type === "over") {
    const { winner } = state.phase;
    const result: Cue = !player || winner === null ? "end" : winner === viewer ? "win" : "lose";
    cues.push({ cue: result, afterMs: busyUntil + BEFORE_RESULT_MS });
  }
  return cues;
}
