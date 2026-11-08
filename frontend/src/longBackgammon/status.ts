import type { LongBackgammonState, Seat, Snapshot, Step } from "../features/game";
import { landing, toViewerIndex } from "./layout";

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
 * A step in the viewer's numbering, "12→18" or "20→off". The step is in its mover's own
 * numbers, which are not the viewer's when the mover is the other player.
 */
export function stepText(step: Step, mover: Seat, viewer: Seat): string {
  const to = landing(step);
  const place = (k: number) => toViewerIndex(k, mover, viewer);
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

/** The result, once the game is over. */
export function resultText(snapshot: Snapshot, mySeat: Seat | null): string {
  const phase = snapshot.state?.phase;
  if (phase?.type !== "over") return "";
  if (phase.winner === null) return "The game is a draw.";
  const name = nameOf(snapshot, phase.winner, mySeat);
  const score = phase.points >= 2 ? `mars, ${phase.points} points` : `${phase.points} point`;
  return `${name} won the game (${score}).`;
}

/** What the previous turn came to, or "" if no turn has been played. */
export function lastTurnText(snapshot: Snapshot, mySeat: Seat | null): string {
  const last = snapshot.state?.lastTurn;
  if (!snapshot.state || !last) return "";
  const name = nameOf(snapshot, last.seat, mySeat);
  const viewer = viewerSeat(mySeat, snapshot.state);
  const rolled = `${name} rolled ${diceText(last.dice)}`;
  if (last.played.length === 0) return `${rolled} and could not move.`;
  const steps = last.played.map((step) => stepText(step, last.seat, viewer)).join(", ");
  return `${rolled} and played ${steps}.`;
}

/** The warning that White is out and Black has one throw left, or "". */
export function lastThrowText(state: LongBackgammonState): string {
  if (!state.lastThrow || state.phase.type === "over") return "";
  return "White has borne off everything. Black gets one last throw.";
}
