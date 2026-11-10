import {
  type Action,
  HEX,
  type HexSnapshot,
  LONG_BACKGAMMON,
  type LongBackgammonSnapshot,
  type Snapshot,
  ULTIMATE_TIC_TAC_TOE,
  type UtttSnapshot,
} from "./schemas";
import { seatOf } from "./selectors";

/**
 * How long auto-play waits before each action. Long enough for the dice to settle and the
 * last checker to land, so that what it plays can be followed on the board.
 */
export const AUTOPLAY_PAUSE_MS = 800;

/** The mover's own point 1, where all 15 checkers start. */
const HEAD = 1;

/**
 * What auto-play does now, in a game of any kind (see below for what each plays). Null when
 * there is nothing for `userId` to do: it is not their turn, or the game has not started or is over.
 *
 * It picks only from what the server offers, so it needs no rules of its own.
 *
 * `random` returns a number from 0 up to, not including, 1, like `Math.random`.
 */
export function autoplayAction(
  snapshot: Snapshot,
  userId: string | null,
  random: () => number = Math.random,
): Action | null {
  switch (snapshot.kind) {
    case LONG_BACKGAMMON:
      return longBackgammonAction(snapshot, userId, random);
    case ULTIMATE_TIC_TAC_TOE:
      return ultimateTicTacToeAction(snapshot, userId, random);
    case HEX:
      return hexAction(snapshot, userId, random);
  }
}

/**
 * Long backgammon: roll when it is time to roll, else play a step. It takes a checker off the
 * head whenever a legal step from the head exists, as the opening of long backgammon calls for;
 * among the steps it may choose from (the ones off the head, else all of them) every one is
 * equally likely. A turn in which nothing can be played never reaches it: the server ends such a
 * turn itself.
 */
function longBackgammonAction(
  snapshot: LongBackgammonSnapshot,
  userId: string | null,
  random: () => number,
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

/**
 * Ultimate tic-tac-toe: marks an empty cell of a board the server says may be played in. Every such
 * cell is equally likely.
 */
function ultimateTicTacToeAction(
  snapshot: UtttSnapshot,
  userId: string | null,
  random: () => number,
): Action | null {
  const state = snapshot.state;
  if (state?.phase.type !== "play" || seatOf(snapshot, userId) !== state.turn) return null;

  const choices = state.playable.flatMap((board) =>
    (state.cells[board] ?? []).flatMap((seat, cell) => (seat === null ? [{ board, cell }] : [])),
  );
  const choice = choices[Math.floor(random() * choices.length)];
  return choice ? { type: "play", ...choice } : null;
}

/**
 * Hex: puts a stone on an empty cell, or swaps when the server says the player may. The swap is
 * one choice among the cells, so every choice is equally likely.
 */
function hexAction(snapshot: HexSnapshot, userId: string | null, random: () => number): Action | null {
  const state = snapshot.state;
  if (state?.phase.type !== "play" || seatOf(snapshot, userId) !== state.turn) return null;

  const choices: Action[] = state.cells.flatMap((seat, cell) =>
    seat === null ? [{ type: "place" as const, column: cell % state.size, row: Math.floor(cell / state.size) }] : [],
  );
  if (state.canSwap) choices.push({ type: "swap" });
  return choices[Math.floor(random() * choices.length)] ?? null;
}
