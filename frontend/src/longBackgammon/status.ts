import type { LongBackgammonState, Seat, Snapshot, Step } from "../features/game";
import { landing, pointNumber } from "./layout";

// The words on the page, derived from a snapshot. Kept apart from the components so that
// every sentence can be tested.

/** The seat the page is drawn for: the user's own, or White's for someone who is watching. */
export function viewerSeat(mySeat: Seat | null, state: LongBackgammonState | null): Seat {
  return mySeat ?? state?.white ?? 0;
}

/** A seat in a sentence: "You", the player's name, or "Player 2" if they have none. */
export function nameOf(snapshot: Snapshot, seat: Seat, mySeat: Seat | null): string {
  if (seat === mySeat) return "You";
  return snapshot.playerNames[seat] ?? `Player ${seat + 1}`;
}

/** A seat for the bar above or below the board. An empty seat is waiting. */
export function barNameOf(snapshot: Snapshot, seat: Seat, mySeat: Seat | null): string {
  if (seat >= snapshot.players.length) return "Waiting for an opponent…";
  const name = snapshot.playerNames[seat];
  if (seat === mySeat) return name ? `${name} (you)` : "You";
  return name ?? `Player ${seat + 1}`;
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
export function turnText(snapshot: Snapshot, mySeat: Seat | null): string {
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

/** How a game ended, in two parts: who won, and what it was worth. */
export interface Result {
  /** "You won", "Ada won" or "Draw". */
  title: string;
  /** "1 point", "Mars: 2 points", or "" for a draw. */
  detail: string;
  /** The viewer is a player, and it was them. */
  won: boolean;
}

/** The result, once the game is over; null while it is on. */
export function resultOf(snapshot: Snapshot, mySeat: Seat | null): Result | null {
  const phase = snapshot.state?.phase;
  if (phase?.type !== "over") return null;
  if (phase.winner === null) return { title: "Draw", detail: "", won: false };
  const title = `${nameOf(snapshot, phase.winner, mySeat)} won`;
  const detail = phase.points >= 2 ? `Mars: ${phase.points} points` : `${phase.points} point`;
  return { title, detail, won: phase.winner === mySeat };
}

/**
 * What the viewer can do about the rematch of a finished game, and what to tell them:
 *
 * - `closed`: nothing. They only watch, and there is no rematch yet.
 * - `ask`: they can ask for one. `line` says so if their last ask was turned down.
 * - `waiting`: they have asked, and the other player has not answered. They can take it back.
 * - `answer`: the other player has asked. They can say yes or no.
 * - `started`: the new game exists. Anyone can go there.
 */
export type RematchStage =
  | { stage: "closed"; line: "" }
  | { stage: "ask"; line: string }
  | { stage: "waiting"; line: string }
  | { stage: "answer"; line: string }
  | { stage: "started"; line: string; gameId: string };

/** Where the rematch stands for the viewer. Only meaningful once the game is over. */
export function rematchStage(snapshot: Snapshot, mySeat: Seat | null): RematchStage {
  const rematch = snapshot.rematch;
  if (rematch?.type === "accepted") {
    return { stage: "started", line: "The rematch has started.", gameId: rematch.gameId };
  }
  if (mySeat === null || snapshot.players.length < 2) return { stage: "closed", line: "" };

  const other = (1 - mySeat) as Seat;
  const name = nameOf(snapshot, other, mySeat);
  if (rematch?.type === "offered") {
    return rematch.by === mySeat
      ? { stage: "waiting", line: `Waiting for ${name} to accept the rematch…` }
      : { stage: "answer", line: `${name} wants a rematch.` };
  }
  // A `declined` is news only to the one who was turned down. The one who said no knows.
  const turnedDown = rematch?.type === "declined" && rematch.by === mySeat;
  return { stage: "ask", line: turnedDown ? `${name} declined the rematch.` : "" };
}

/** What the previous turn came to, or "" if no turn has been played. */
export function lastTurnText(snapshot: Snapshot, mySeat: Seat | null): string {
  const last = snapshot.state?.lastTurn;
  if (!snapshot.state || !last) return "";
  const name = nameOf(snapshot, last.seat, mySeat);
  const rolled = `${name} rolled ${diceText(last.dice)}`;
  if (last.played.length === 0) return `${rolled} and could not move.`;
  const { white } = snapshot.state;
  const steps = last.played.map((step) => stepText(step, last.seat, white)).join(", ");
  return `${rolled} and played ${steps}.`;
}

/** The warning that White is out and Black has one throw left, or "". */
export function lastThrowText(state: LongBackgammonState): string {
  if (!state.lastThrow || state.phase.type === "over") return "";
  return "White has borne off everything. Black gets one last throw.";
}
