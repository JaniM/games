// Game positions for tests: the shapes the server sends, built from small pieces. Long backgammon
// first, then ultimate tic-tac-toe, then Hex.

import {
  HEX,
  type HexSnapshot,
  type HexState,
  LONG_BACKGAMMON,
  type LongBackgammonSnapshot,
  type LongBackgammonState,
  type Phase,
  type Seat,
  type Step,
  ULTIMATE_TIC_TAC_TOE,
  type UtttSnapshot,
  type UtttState,
} from "./features/game";
import { gameIdOf } from "./testing";

export const GAME_ID = gameIdOf(1);

/** `count` checkers on each listed point (a player's own numbering, 1..24). */
export function board(onPoints: Record<number, number>): number[] {
  const points = Array.from({ length: 24 }, () => 0);
  for (const [point, count] of Object.entries(onPoints)) points[Number(point) - 1] = count;
  return points;
}

/** A game just started: seat 0 is White and about to roll, with all checkers on their heads. */
export function startingState(overrides: Partial<LongBackgammonState> = {}): LongBackgammonState {
  return {
    white: 0,
    points: [board({ 1: 15 }), board({ 1: 15 })],
    off: [0, 0],
    turn: 0,
    turns: [0, 0],
    lastThrow: false,
    phase: { type: "roll" },
    legal: [],
    combos: [],
    lastTurn: null,
    ...overrides,
  };
}

/**
 * The mover has rolled `dice` and has not played yet (`remaining` defaults to the dice).
 * `combos` are the lines of two or more steps by one checker that the server lists.
 */
export function moving(
  dice: [number, number],
  legal: Step[],
  played: Step[] = [],
  remaining: number[] = dice[0] === dice[1] ? [dice[0], dice[0], dice[0], dice[0]] : [...dice],
  combos: Step[][] = [],
): Pick<LongBackgammonState, "phase" | "legal" | "combos"> {
  const phase: Phase = { type: "move", dice, remaining, played };
  return { phase, legal, combos };
}

/** What a snapshot holds once the client has read it. */
export function snapshotOf(overrides: Partial<LongBackgammonSnapshot> = {}): LongBackgammonSnapshot {
  return {
    kind: LONG_BACKGAMMON,
    revision: 1,
    players: ["user-a", "user-b"],
    playerNames: ["Ada", "Grace"],
    // Both have accounts, so their names are shown as they are.
    playerGuests: [false, false],
    state: startingState(),
    rematch: null,
    ...overrides,
  };
}

/** The message the server sends: a snapshot, with its envelope. */
export function snapshotMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "snapshot",
    gameId: GAME_ID,
    stateVersion: 1,
    ...snapshotOf(),
    ...overrides,
  };
}

// --- Ultimate tic-tac-toe ---

/** The nine boards of nine empty cells. */
export function emptyCells(): (Seat | null)[][] {
  return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => null));
}

/**
 * The cells with marks on them: `{ 4: { 0: 1, 4: 0 } }` is seat 1's mark in cell 0 and seat 0's in
 * cell 4 of board 4. Boards and cells are counted from 0.
 */
export function marks(placed: Record<number, Record<number, Seat>>): (Seat | null)[][] {
  const cells = emptyCells();
  for (const [board, inBoard] of Object.entries(placed)) {
    for (const [cell, seat] of Object.entries(inBoard)) {
      const row = cells[Number(board)];
      if (row) row[Number(cell)] = seat;
    }
  }
  return cells;
}

/** Every cell of `board` marked by `seat`'s line along `line`, and the rest by nobody: a board `seat` has won. */
export function wonBoard(seat: Seat, line: [number, number, number] = [0, 1, 2]): Record<number, Seat> {
  return Object.fromEntries(line.map((cell) => [cell, seat]));
}

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
] as const;

/** The seat that has a line among `marked`, which is nine places holding a seat or null. */
function lineOwner(marked: readonly (Seat | null)[]): Seat | null {
  for (const [a, b, c] of LINES) {
    const seat = marked[a as number];
    if (seat != null && seat === marked[b as number] && seat === marked[c as number]) return seat;
  }
  return null;
}

/**
 * A game of ultimate tic-tac-toe in the state the server sends, with the boards worked out from
 * the cells, as the server does: a board is won by whoever has a line in it, drawn once it is full,
 * open otherwise. `line` and `playable` are left to the test, which says what the position is for:
 * by default every open board may be played, as after a mark that sent nobody anywhere in particular.
 */
export function utttState(overrides: Partial<UtttState> = {}): UtttState {
  const cells = overrides.cells ?? emptyCells();
  const boards: UtttState["boards"] = cells.map((marked) => {
    const owner = lineOwner(marked);
    if (owner !== null) return { type: "won", seat: owner };
    return marked.every((cell) => cell !== null) ? { type: "drawn" } : { type: "open" };
  });
  const open = boards.flatMap((board, index) => (board.type === "open" ? [index] : []));
  const over = overrides.phase?.type === "over";
  return {
    x: 0,
    turn: 0,
    last: null,
    phase: { type: "play" },
    line: null,
    ...overrides,
    cells,
    boards: overrides.boards ?? boards,
    playable: overrides.playable ?? (over ? [] : open),
  };
}

/** What a snapshot of an ultimate tic-tac-toe game holds once the client has read it. */
export function utttSnapshotOf(overrides: Partial<UtttSnapshot> = {}): UtttSnapshot {
  return {
    kind: ULTIMATE_TIC_TAC_TOE,
    revision: 1,
    players: ["user-a", "user-b"],
    playerNames: ["Ada", "Grace"],
    playerGuests: [false, false],
    state: utttState(),
    rematch: null,
    ...overrides,
  };
}

/** The message the server sends for an ultimate tic-tac-toe game. */
export function utttSnapshotMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "snapshot",
    gameId: GAME_ID,
    stateVersion: 1,
    ...utttSnapshotOf(),
    ...overrides,
  };
}

// --- Hex ---

/** The 121 empty cells of the board, row by row. */
export function emptyHexCells(): (Seat | null)[] {
  return Array.from({ length: 11 * 11 }, () => null);
}

/** The column and row of a cell named as in the rules: `a1` is column 0, row 0. */
export function cellAt(name: string): { column: number; row: number } {
  return { column: name.charCodeAt(0) - 97, row: Number(name.slice(1)) - 1 };
}

/** The cells with stones on them, by name: `{ f6: 0, e5: 1 }` is seat 0's stone on f6 and seat 1's on e5. */
export function stones(placed: Record<string, Seat>): (Seat | null)[] {
  const cells = emptyHexCells();
  for (const [name, seat] of Object.entries(placed)) {
    const { column, row } = cellAt(name);
    cells[row * 11 + column] = seat;
  }
  return cells;
}

/**
 * A game of Hex in the state the server sends: an empty board with seat 0 as Red and to move,
 * unless the test says otherwise. Nothing is worked out from the cells: `canSwap` and `chain` are
 * the test's to say, as the position needs them.
 */
export function hexState(overrides: Partial<HexState> = {}): HexState {
  return {
    size: 11,
    red: 0,
    cells: emptyHexCells(),
    turn: 0,
    swapped: false,
    last: null,
    phase: { type: "play" },
    canSwap: false,
    chain: null,
    ...overrides,
  };
}

/** What a snapshot of a Hex game holds once the client has read it. */
export function hexSnapshotOf(overrides: Partial<HexSnapshot> = {}): HexSnapshot {
  return {
    kind: HEX,
    revision: 1,
    players: ["user-a", "user-b"],
    playerNames: ["Ada", "Grace"],
    playerGuests: [false, false],
    state: hexState(),
    rematch: null,
    ...overrides,
  };
}

/** The message the server sends for a Hex game. */
export function hexSnapshotMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "snapshot",
    gameId: GAME_ID,
    stateVersion: 1,
    ...hexSnapshotOf(),
    ...overrides,
  };
}
