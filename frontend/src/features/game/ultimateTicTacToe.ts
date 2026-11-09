import { z } from "zod";
import { seatSchema } from "./seat";

// The state of an ultimate tic-tac-toe game, as the server sends it (rules in
// `docs/games/ultimate-tic-tac-toe.md`; the server's own description is in
// `backend/src/ultimate_tic_tac_toe/mod.rs`). The server owns the rules: the client only draws
// this, and uses `playable` to know where a mark may go. Boards and cells are counted from 0, in
// reading order: 0 1 2 / 3 4 5 / 6 7 8.

/** A board or a cell, 0..8. */
const indexSchema = z.number().int().min(0).max(8);

/** Where a small board stands. A won board belongs to the seat that won it; a drawn one to nobody. */
export const boardResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open") }),
  z.object({ type: z.literal("drawn") }),
  z.object({ type: z.literal("won"), seat: seatSchema }),
]);
export type BoardResult = z.infer<typeof boardResultSchema>;

export const phaseSchema = z.discriminatedUnion("type", [
  /** `turn` marks a cell. */
  z.object({ type: z.literal("play") }),
  /** `winner` is null for a draw. `forfeited`: the other player gave up (D10 in the rules). */
  z.object({ type: z.literal("over"), winner: seatSchema.nullable(), forfeited: z.boolean() }),
]);
export type UtttPhase = z.infer<typeof phaseSchema>;

/** The three boards of a line, ascending: 0 1 2, or 2 4 6. */
export const lineSchema = z.tuple([indexSchema, indexSchema, indexSchema]);

export const stateSchema = z.object({
  /** The seat that plays X, and moves first. The other seat is O. */
  x: seatSchema,
  /** `cells[board][cell]` is the seat that marked it, or null while it is empty. */
  cells: z.array(z.array(seatSchema.nullable()).length(9)).length(9),
  /** The seat to move; after the game, the seat that moved last. */
  turn: seatSchema,
  /** The mark placed last, once there is one. It is kept after the game ends. */
  last: z.object({ seat: seatSchema, board: indexSchema, cell: indexSchema }).nullable(),
  phase: phaseSchema,
  /** How each small board stands. */
  boards: z.array(boardResultSchema).length(9),
  /** The boards `turn` may play in: where the last mark sent them, or any open board. Empty unless the phase is `play`. */
  playable: z.array(indexSchema),
  /** The line of three boards that won the game, if it was won that way: not for a draw or a forfeit. */
  line: lineSchema.nullable(),
});
export type UtttState = z.infer<typeof stateSchema>;

/** Marks the cell `cell` of the small board `board`. The server decides whether it is allowed. */
export const actionSchema = z.object({
  type: z.literal("play"),
  board: indexSchema,
  cell: indexSchema,
});
export type UtttAction = z.infer<typeof actionSchema>;
