import type { LongBackgammonSnapshot, LongBackgammonState, Seat, Step } from "../features/game";
import {
  type FrameText,
  type RematchStage,
  type Result,
  barNameOf,
  inSentence,
  nameOf,
  rematchStage,
} from "../components/game/people";
import { landing, pointNumber } from "./layout";

// The words on the page, derived from a snapshot. Kept apart from the components so that
// every sentence can be tested. The words about the people (names, the rematch) are the same for
// every game: they are in `components/game/people.ts`, and come out of here too.

export { barNameOf, nameOf, rematchStage };
export type { FrameText, RematchStage, Result };

/** The seat the page is drawn for: the user's own, or White's for someone who is watching. */
export function viewerSeat(mySeat: Seat | null, state: LongBackgammonState | null): Seat {
  return mySeat ?? state?.white ?? 0;
}

/** "6-5". */
export function diceText(dice: readonly [number, number]): string {
  return `${dice[0]}-${dice[1]}`;
}

/**
 * A step in the numbering both players share, "24→18" or "3→off". The step is in its
 * mover's own numbers, which are not the shared ones (see `pointNumber`).
 */
export function stepText(step: Step, mover: Seat, white: Seat): string {
  const to = landing(step);
  const place = (k: number) => pointNumber(k, mover, white);
  return `${place(step.from)}→${to === "off" ? "off" : place(to)}`;
}

/** What the player to move should do next, or who we wait for. Empty when the game is over. */
export function turnText(snapshot: LongBackgammonSnapshot, mySeat: Seat | null): string {
  const state = snapshot.state;
  if (!state) return "Waiting for an opponent to join.";
  if (state.phase.type === "over") return "";
  const mine = state.turn === mySeat;
  const name = nameOf(snapshot, state.turn, mySeat);
  if (state.phase.type === "roll") {
    return mine ? "Your turn. Roll the dice." : `Waiting for ${name} to roll.`;
  }
  const left = state.phase.remaining.length;
  if (mine) {
    return `Your turn. Pick a checker to move (${left} ${left === 1 ? "die" : "dice"} left).`;
  }
  return `Waiting for ${name} to move.`;
}

/** The result, once the game is over; null while it is on. */
export function resultOf(snapshot: LongBackgammonSnapshot, mySeat: Seat | null): Result | null {
  const phase = snapshot.state?.phase;
  if (phase?.type !== "over") return null;
  if (phase.winner === null) return { title: "Draw", detail: "", forfeited: false, won: false };
  const title = `${nameOf(snapshot, phase.winner, mySeat)} won`;
  const won = phase.winner === mySeat;
  if (phase.forfeited) {
    // A forfeit always scores 1 point, so it is not worth saying. Who gave up is.
    const loser = nameOf(snapshot, (1 - phase.winner) as Seat, mySeat);
    return { title, detail: `${loser} forfeited`, forfeited: true, won };
  }
  const detail = phase.points >= 2 ? `Mars: ${phase.points} points` : `${phase.points} point`;
  return { title, detail, forfeited: false, won };
}

/** The warning that White is out and Black has one throw left, or "". */
export function lastThrowText(state: LongBackgammonState): string {
  if (!state.lastThrow || state.phase.type === "over") return "";
  return "White has borne off everything. Black gets one last throw.";
}

/**
 * The words for a position of the past. They come from the position alone, so they are the same
 * whether the user stepped to it or jumped: a roll leaves the dice to play and nothing played,
 * a step is the last of the turn's, and a step that ended the turn is the turn before in
 * `lastTurn`, since the turn has passed on by then.
 */
export function frameText(snapshot: LongBackgammonSnapshot, state: LongBackgammonState, mySeat: Seat | null): FrameText {
  const result = resultOf({ ...snapshot, state }, mySeat);
  const detail = result
    ? `Game over. ${result.title}${result.detail ? `, ${inSentence(result)}` : ""}.`
    : lastThrowText(state);

  if (state.phase.type === "move") {
    const name = nameOf(snapshot, state.turn, mySeat);
    const step = state.phase.played.at(-1);
    const title = step
      ? `${name} played ${stepText(step, state.turn, state.white)}`
      : `${name} rolled ${diceText(state.phase.dice)}`;
    return { title, detail };
  }

  const last = state.lastTurn;
  if (!last) return { title: "Start of the game", detail };
  const name = nameOf(snapshot, last.seat, mySeat);
  const step = last.played.at(-1);
  const title = step
    ? `${name} played ${stepText(step, last.seat, state.white)}`
    : `${name} rolled ${diceText(last.dice)} and could not move`;
  return { title, detail };
}
