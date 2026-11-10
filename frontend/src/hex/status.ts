import type { HexSnapshot, HexState, Seat } from "../features/game";
import { stoneAt } from "../features/game/hex";
import { type FrameText, type Result, inSentence, nameOf } from "../components/game/people";

// The words on the page, derived from a snapshot. Kept apart from the components so that every
// sentence can be tested. Columns and rows are counted from 0 in the state, and a person reads a
// cell as the rules name it: `a1` is column 0, row 0.

/** Which colour a seat plays. */
export type Colour = "red" | "blue";

/** The colour `seat` plays: Red for the seat that moves first. */
export function colourOf(state: HexState, seat: Seat): Colour {
  return state.red === seat ? "red" : "blue";
}

/** "Red" or "Blue", for a sentence. */
export function colourName(colour: Colour): string {
  return colour === "red" ? "Red" : "Blue";
}

/** The edges a colour joins, as a person says them. */
export function edgesOf(colour: Colour): string {
  return colour === "red" ? "top and bottom" : "left and right";
}

/** The seat the page is drawn for: the user's own, or Red's for someone who is watching. */
export function viewerSeat(mySeat: Seat | null, state: HexState | null): Seat {
  return mySeat ?? state?.red ?? 0;
}

/** A cell as the rules name it: column 0, row 0 is "a1". */
export function cellName(column: number, row: number): string {
  return `${String.fromCharCode(97 + column)}${row + 1}`;
}

/** What the player to move should do next, or who we wait for. Empty when the game is over. */
export function turnText(snapshot: HexSnapshot, mySeat: Seat | null): string {
  const state = snapshot.state;
  if (!state) return "Waiting for an opponent to join.";
  if (state.phase.type === "over") return "";
  if (state.turn !== mySeat) return `Waiting for ${nameOf(snapshot, state.turn, mySeat)} to play.`;
  if (state.canSwap) return "Your turn. Place a stone, or swap to make Red's stone yours.";
  return `Your turn. Join the ${edgesOf(colourOf(state, mySeat))} edges.`;
}

/** The result, once the game is over; null while it is on. */
export function resultOf(snapshot: HexSnapshot, mySeat: Seat | null): Result | null {
  const state = snapshot.state;
  const phase = state?.phase;
  if (!state || phase?.type !== "over") return null;
  const title = `${nameOf(snapshot, phase.winner, mySeat)} won`;
  const won = phase.winner === mySeat;
  if (phase.forfeited) {
    const loser = nameOf(snapshot, (1 - phase.winner) as Seat, mySeat);
    return { title, detail: `${loser} forfeited`, forfeited: true, won };
  }
  const edges = edgesOf(colourOf(state, phase.winner));
  return { title, detail: `Joined the ${edges} edges`, forfeited: false, won };
}

/**
 * The words for a position of the past. They come from the position alone, so they are the same
 * whether the user stepped to it or jumped: the move that was just made, or the start of the game,
 * and how the game ended once it is over.
 */
export function frameText(snapshot: HexSnapshot, state: HexState, mySeat: Seat | null): FrameText {
  const result = resultOf({ ...snapshot, state }, mySeat);
  const detail = result ? `Game over. ${result.title}${result.detail ? `, ${inSentence(result)}` : ""}.` : "";
  const { last } = state;
  if (!last) return { title: "Start of the game", detail };
  const name = nameOf(snapshot, last.seat, mySeat);
  const cell = cellName(last.column, last.row);
  if (last.swap) return { title: `${name} swapped: Red's stone is now Blue's, on ${cell}`, detail };
  return { title: `${name} placed a stone on ${cell}`, detail };
}

/** A cell for a screen reader: its name, and what is on it. */
export function cellLabel(state: HexState, column: number, row: number): string {
  const seat = stoneAt(state, column, row);
  const what = seat === null ? "empty" : colourName(colourOf(state, seat));
  return `${cellName(column, row)}, ${what}`;
}
