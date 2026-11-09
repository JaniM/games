import { z } from "zod";

// The state of a long backgammon game, as the server sends it. The server owns the
// rules: the client only draws this and uses `legal` to know what may be clicked.
// When a second game arrives, the state moves out of this file and the snapshot
// becomes generic over it.

const seatSchema = z.union([z.literal(0), z.literal(1)]);

/**
 * One die played by one checker: the checker on the mover's own point `from`
 * moves `die` points. From `from + die` = 25 on, it bears off.
 */
export const stepSchema = z.object({ from: z.number().int(), die: z.number().int() });
export type Step = z.infer<typeof stepSchema>;

export const phaseSchema = z.discriminatedUnion("type", [
  /** `turn` must roll. */
  z.object({ type: z.literal("roll") }),
  /** The dice are rolled; `remaining` are the dice still to play (four for a double at first). */
  z.object({
    type: z.literal("move"),
    dice: z.tuple([z.number().int(), z.number().int()]),
    remaining: z.array(z.number().int()),
    played: z.array(stepSchema),
  }),
  /** `winner` is null for a draw. `points` is 2 for a mars. */
  z.object({
    type: z.literal("over"),
    winner: seatSchema.nullable(),
    points: z.number().int(),
  }),
]);
export type Phase = z.infer<typeof phaseSchema>;

const pointsSchema = z.array(z.number().int()).length(24);

export const stateSchema = z.object({
  /** The seat that moves first. The other seat is Black. */
  white: seatSchema,
  /** By seat, then by the seat's own point 1..24 (array index 0..23). Point 19..24 is home. */
  points: z.tuple([pointsSchema, pointsSchema]),
  /** Checkers borne off, by seat. */
  off: z.tuple([z.number().int(), z.number().int()]),
  /** The seat to move. */
  turn: seatSchema,
  /** Turns each seat has completed. */
  turns: z.tuple([z.number().int(), z.number().int()]),
  /** White has borne off everything, and Black gets one last turn. */
  lastThrow: z.boolean(),
  phase: phaseSchema,
  /** Every single step `turn` may play now. Empty unless the phase is `move`. */
  legal: z.array(stepSchema),
  /**
   * The ways to play two or more dice with one checker in a row, so that they can be offered
   * as one move. Each is a list of steps, each starting where the one before landed, and each
   * legal in the position the steps before it lead to: playing them one at a time is allowed
   * (the client sends them as separate `move` actions). Empty unless the phase is `move`.
   */
  combos: z.array(z.array(stepSchema)),
  /** The turn before this one, once there is one. `played` is empty if the player could not move. */
  lastTurn: z
    .object({
      seat: seatSchema,
      dice: z.tuple([z.number().int(), z.number().int()]),
      played: z.array(stepSchema),
    })
    .nullable(),
});
export type LongBackgammonState = z.infer<typeof stateSchema>;
export type Seat = 0 | 1;

/**
 * Where the rematch of a finished game stands. It is not part of the rules, so it is beside
 * the state in a snapshot. A rematch is a new game with the same two players.
 */
export const rematchSchema = z.discriminatedUnion("type", [
  /** The player in seat `by` has asked to play again, and the other has not answered. */
  z.object({ type: z.literal("offered"), by: seatSchema }),
  /** The other player turned down the offer of the player in seat `by`. */
  z.object({ type: z.literal("declined"), by: seatSchema }),
  /** Both want it, and the new game exists. */
  z.object({ type: z.literal("accepted"), gameId: z.string() }),
]);
export type Rematch = z.infer<typeof rematchSchema>;

/** The only kind of game this client plays. A snapshot of any other kind is not for this page. */
export const KIND = "long-backgammon";

/** The only layout of `state` this client reads. */
export const STATE_VERSION = 1;

/** What a snapshot message carries, with the state still unread so a bad one can be reported. */
export const incomingSnapshotSchema = z.object({
  type: z.literal("snapshot"),
  gameId: z.string(),
  kind: z.string(),
  revision: z.number().int(),
  stateVersion: z.number().int(),
  players: z.array(z.string()),
  playerNames: z.array(z.string().nullable()),
  state: z.unknown(),
  /** Left out by a server from before rematches, which means none. */
  rematch: rematchSchema.nullish(),
});

/** What the client keeps of a snapshot. `state` is null until both seats are taken. */
export const snapshotSchema = z.object({
  revision: z.number().int(),
  /** User ids by seat. */
  players: z.array(z.string()),
  /** Display names by seat; null for a player who has not picked one. */
  playerNames: z.array(z.string().nullable()),
  state: stateSchema.nullable(),
  /** Null until a player of the finished game asks to play it again. */
  rematch: rematchSchema.nullable(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const errorMessageSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

/** What a player may send. The server decides whether it is allowed. */
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("roll") }),
  z.object({ type: z.literal("move"), from: z.number().int(), die: z.number().int() }),
  /** Takes back the last step of the turn in progress, and gives its die back. */
  z.object({ type: z.literal("undo") }),
]);
export type Action = z.infer<typeof actionSchema>;

/** What `POST /api/games/{id}/join` returns. */
export const seatReplySchema = z.object({ gameId: z.string(), seat: z.number().int() });
