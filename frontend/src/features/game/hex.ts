import { z } from "zod";
import { seatSchema } from "./seat";

// The state of a Hex game, as the server sends it (rules in `docs/games/hex.md`; the server's own
// description is in `backend/src/hex/mod.rs`). The server owns the rules: the client only draws
// this. A stone may go on any empty cell, and the swap is offered only when `canSwap` says so.
// Columns and rows are counted from 0: the doc's `a1` is column 0, row 0, and `k11` is 10, 10.

/** Cells on a side. */
export const HEX_SIZE = 11;

/** A column or a row, 0..10. */
const indexSchema = z.number().int().min(0).max(HEX_SIZE - 1);

/** A cell: column 0 is `a`, row 0 is row 1. */
export const cellSchema = z.object({ column: indexSchema, row: indexSchema });
export type HexCell = z.infer<typeof cellSchema>;

export const phaseSchema = z.discriminatedUnion("type", [
  /** `turn` places a stone, or swaps if `canSwap`. */
  z.object({ type: z.literal("play") }),
  /** There are no draws, so there is always a winner. `forfeited`: the other player gave up (D9). */
  z.object({ type: z.literal("over"), winner: seatSchema, forfeited: z.boolean() }),
]);
export type HexPhase = z.infer<typeof phaseSchema>;

export const stateSchema = z.object({
  /**
   * The cells on a side of the board. The server plays only 11 for now, and this client draws only
   * 11: a state of another size is one it can't read, like a layout it doesn't know.
   */
  size: z.literal(HEX_SIZE),
  /** The seat that plays Red, and moves first. The other seat is Blue, for the whole game. */
  red: seatSchema,
  /**
   * The board, row by row: `size` × `size` cells, each the seat whose stone is there, or null while
   * it is empty. The cell in `column` and `row` is `cells[row * size + column]` (see `stoneAt`).
   */
  cells: z.array(seatSchema.nullable()).length(HEX_SIZE * HEX_SIZE),
  /** The seat to move; after the game, the seat that moved last. */
  turn: seatSchema,
  /** Blue has swapped. */
  swapped: z.boolean(),
  /**
   * The last move, once there is one: the stone it placed. For the swap (`swap`) that is Blue's
   * stone on the mirror cell, and Red's stone was on the mirror of it (column and row the other way
   * round). It is kept after the game ends.
   */
  last: z.object({ seat: seatSchema, column: indexSchema, row: indexSchema, swap: z.boolean() }).nullable(),
  phase: phaseSchema,
  /** The player to move may swap: it is Blue's first turn. */
  canSwap: z.boolean(),
  /** The cells of the chain that won, in reading order. Null for a forfeit and a game that is on. */
  chain: z.array(cellSchema).nullable(),
});
export type HexState = z.infer<typeof stateSchema>;

/** The seat whose stone is on the cell in `column` and `row`, or null if it is empty or off the board. */
export function stoneAt(state: Pick<HexState, "size" | "cells">, column: number, row: number): 0 | 1 | null {
  if (column < 0 || row < 0 || column >= state.size || row >= state.size) return null;
  return state.cells[row * state.size + column] ?? null;
}

/** Puts a stone on an empty cell. The server decides whether it is allowed. */
export const placeSchema = z.object({ type: z.literal("place"), column: indexSchema, row: indexSchema });

/** Blue's swap, on Blue's first turn: Red's stone becomes Blue's, on the mirror cell. */
export const swapSchema = z.object({ type: z.literal("swap") });

export type HexAction = z.infer<typeof placeSchema> | z.infer<typeof swapSchema>;
