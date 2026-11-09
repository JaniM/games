import type { Seat, UtttSnapshot, UtttState } from "../features/game";
import { type FrameText, type Result, inSentence, nameOf } from "../gameUi/people";

// The words on the page, derived from a snapshot. Kept apart from the components so that
// every sentence can be tested. Boards and cells are counted from 0 in the state, and from 1
// in what a person reads (as in the rules): "cell 3 of board 5" is `board: 4, cell: 2`.

/** Which mark a seat plays. */
export type Mark = "x" | "o";

/** The mark `seat` plays: X for the seat that moves first. */
export function markOf(state: UtttState, seat: Seat): Mark {
  return state.x === seat ? "x" : "o";
}

/** "X" or "O", for a sentence. */
export function markName(mark: Mark): string {
  return mark === "x" ? "X" : "O";
}

/** The seat the page is drawn for: the user's own, or X's for someone who is watching. */
export function viewerSeat(mySeat: Seat | null, state: UtttState | null): Seat {
  return mySeat ?? state?.x ?? 0;
}

/** How many small boards `seat` has won. */
export function boardsWon(state: UtttState, seat: Seat): number {
  return state.boards.filter((board) => board.type === "won" && board.seat === seat).length;
}

/** A place on the board as a person says it: "cell 3 of board 5". */
export function placeText(board: number, cell: number): string {
  return `cell ${cell + 1} of board ${board + 1}`;
}

/** What the player to move should do next, or who we wait for. Empty when the game is over. */
export function turnText(snapshot: UtttSnapshot, mySeat: Seat | null): string {
  const state = snapshot.state;
  if (!state) return "Waiting for an opponent to join.";
  if (state.phase.type === "over") return "";
  if (state.turn !== mySeat) return `Waiting for ${nameOf(snapshot, state.turn, mySeat)} to play.`;
  // The mover has more than one board to choose from only at the start, or where they were sent to
  // a board that is decided: the first needs no explaining, the second does.
  if (state.last === null) return "Your turn. Play anywhere.";
  if (state.playable.length === 1) return "Your turn. Play in the highlighted board.";
  return "Your turn. That board is decided, so you may play in any open board.";
}

/** The result, once the game is over; null while it is on. */
export function resultOf(snapshot: UtttSnapshot, mySeat: Seat | null): Result | null {
  const phase = snapshot.state?.phase;
  if (phase?.type !== "over") return null;
  if (phase.winner === null) {
    return { title: "Draw", detail: "No one got three boards in a row", forfeited: false, won: false };
  }
  const title = `${nameOf(snapshot, phase.winner, mySeat)} won`;
  const won = phase.winner === mySeat;
  if (phase.forfeited) {
    const loser = nameOf(snapshot, (1 - phase.winner) as Seat, mySeat);
    return { title, detail: `${loser} forfeited`, forfeited: true, won };
  }
  return { title, detail: "Three boards in a row", forfeited: false, won };
}

/**
 * The words for a position of the past. They come from the position alone, so they are the same
 * whether the user stepped to it or jumped: the mark that was just placed, or the start of the
 * game, and how the game ended once it is over.
 */
export function frameText(snapshot: UtttSnapshot, state: UtttState, mySeat: Seat | null): FrameText {
  const result = resultOf({ ...snapshot, state }, mySeat);
  const detail = result ? `Game over. ${result.title}${result.detail ? `, ${inSentence(result)}` : ""}.` : "";
  const { last } = state;
  if (!last) return { title: "Start of the game", detail };
  const name = nameOf(snapshot, last.seat, mySeat);
  return { title: `${name} marked ${placeText(last.board, last.cell)}`, detail };
}

/** A board for a screen reader: where it is, and how it stands. */
export function boardLabel(state: UtttState, board: number): string {
  const result = state.boards[board];
  const where = `Board ${board + 1}`;
  if (!result || result.type === "open") return where;
  if (result.type === "drawn") return `${where}, drawn`;
  return `${where}, won by ${markName(markOf(state, result.seat))}`;
}

/** A cell for a screen reader: where it is, and what is in it. */
export function cellLabel(state: UtttState, board: number, cell: number): string {
  const seat = state.cells[board]?.[cell] ?? null;
  const what = seat === null ? "empty" : markName(markOf(state, seat));
  return `${placeText(board, cell)}, ${what}`;
}
