import { z } from "zod";
import { type Seat, seatSchema } from "./seat";
import * as hex from "./hex";
import * as tictactoe from "./ultimateTicTacToe";

// The state of a long backgammon game, as the server sends it. The server owns the
// rules: the client only draws this and uses `legal` to know what may be clicked.
// The other games' states are in `ultimateTicTacToe.ts` and `hex.ts`. A snapshot or a frame is of one kind of
// game, named by its `kind`, and holds the state of that game: narrow on `kind` before reading it.

/** The kind of a game, as the server names it (`Game::KIND`) and the catalog in `games.ts` does. */
export const LONG_BACKGAMMON = "long-backgammon";
export const ULTIMATE_TIC_TAC_TOE = "ultimate-tic-tac-toe";
export const HEX = "hex";

/** The layout of each kind's `state` this client reads. */
export const STATE_VERSIONS = {
  [LONG_BACKGAMMON]: 1,
  [ULTIMATE_TIC_TAC_TOE]: 1,
  [HEX]: 1,
} as const;
export type GameKind = keyof typeof STATE_VERSIONS;

/** Whether this client has a board for `kind`. A game of another kind is not for this site's pages. */
export function isGameKind(kind: string): kind is GameKind {
  return Object.hasOwn(STATE_VERSIONS, kind);
}

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
  /**
   * `winner` is null for a draw. `points` is 2 for a mars. `forfeited`: the other player gave up,
   * which scores the winner 1 point whatever the board looks like (D10 in the rules).
   */
  z.object({
    type: z.literal("over"),
    winner: seatSchema.nullable(),
    points: z.number().int(),
    forfeited: z.boolean(),
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
export type { Seat };

/** The state of an ultimate tic-tac-toe game. */
export type UtttState = tictactoe.UtttState;
export type UtttPhase = tictactoe.UtttPhase;
export type BoardResult = tictactoe.BoardResult;

/** The state of a Hex game. */
export type HexState = hex.HexState;
export type HexPhase = hex.HexPhase;
export type HexCell = hex.HexCell;

/**
 * A position as the server keeps it in a game's history: the state without what the server
 * works out again from it (`legal` and `combos`). Nothing can be played in a position of the
 * past, so a client puts empty lists back (see `asFrame`) and draws it like any other state.
 */
export const positionSchema = stateSchema.omit({ legal: true, combos: true });
export type Position = z.infer<typeof positionSchema>;

/**
 * One position of a game in review: the kind of game, the state the game was in, and the
 * revision of the snapshot that showed it. Nothing in it is playable: in long backgammon `legal`
 * and `combos` are empty. (In ultimate tic-tac-toe `playable` stays: it says which board was to be
 * played in, which a frame shows as the game does. The board of a review is not pressed. A Hex
 * state is kept whole too: nothing in it is more than a flag.)
 */
export const frameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(LONG_BACKGAMMON), revision: z.number().int(), state: stateSchema }),
  z.object({
    kind: z.literal(ULTIMATE_TIC_TAC_TOE),
    revision: z.number().int(),
    state: tictactoe.stateSchema,
  }),
  z.object({ kind: z.literal(HEX), revision: z.number().int(), state: hex.stateSchema }),
]);
export type Frame = z.infer<typeof frameSchema>;
export type LongBackgammonFrame = Extract<Frame, { kind: typeof LONG_BACKGAMMON }>;
export type UtttFrame = Extract<Frame, { kind: typeof ULTIMATE_TIC_TAC_TOE }>;
export type HexFrame = Extract<Frame, { kind: typeof HEX }>;

/**
 * What `GET /api/games/{id}/history` answers, with the positions still unread so that a bad
 * one can be reported, as with a snapshot's state. They are in the order they were played,
 * and empty for a game from before positions were kept.
 */
export const incomingHistorySchema = z.object({
  gameId: z.string(),
  kind: z.string(),
  stateVersion: z.number().int(),
  positions: z.array(z.object({ revision: z.number().int(), state: z.unknown() })),
});

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

/** What a snapshot message carries, with the state still unread so a bad one can be reported. */
export const incomingSnapshotSchema = z.object({
  type: z.literal("snapshot"),
  gameId: z.string(),
  kind: z.string(),
  revision: z.number().int(),
  stateVersion: z.number().int(),
  players: z.array(z.string()),
  playerNames: z.array(z.string().nullable()),
  /** True for a player with no account: shown with a guest indicator. */
  playerGuests: z.array(z.boolean()),
  state: z.unknown(),
  /** Left out by a server from before rematches, which means none. */
  rematch: rematchSchema.nullish(),
});

/** What every snapshot has, whatever the game: who plays, and where the rematch stands. */
const snapshotParts = {
  revision: z.number().int(),
  /** User ids by seat. */
  players: z.array(z.string()),
  /**
   * Names by seat: an account's username, or what a guest typed. Null for a guest who has not
   * picked one.
   */
  playerNames: z.array(z.string().nullable()),
  /**
   * Who is a guest, by seat. A guest's name is only what they typed, so it is shown with a guest
   * indicator (see `playerName`); the bot and a player who has deleted themselves are not guests.
   */
  playerGuests: z.array(z.boolean()),
  /** Null until a player of the finished game asks to play it again. */
  rematch: rematchSchema.nullable(),
};

/**
 * What the client keeps of a snapshot. `state` is null until both seats are taken. It is of the
 * game the snapshot's `kind` names.
 */
export const snapshotSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(LONG_BACKGAMMON), ...snapshotParts, state: stateSchema.nullable() }),
  z.object({
    kind: z.literal(ULTIMATE_TIC_TAC_TOE),
    ...snapshotParts,
    state: tictactoe.stateSchema.nullable(),
  }),
  z.object({ kind: z.literal(HEX), ...snapshotParts, state: hex.stateSchema.nullable() }),
]);
export type Snapshot = z.infer<typeof snapshotSchema>;
export type LongBackgammonSnapshot = Extract<Snapshot, { kind: typeof LONG_BACKGAMMON }>;
export type UtttSnapshot = Extract<Snapshot, { kind: typeof ULTIMATE_TIC_TAC_TOE }>;
export type HexSnapshot = Extract<Snapshot, { kind: typeof HEX }>;

/** What a snapshot says of the people in a game, whatever the game. The words about them need no more. */
export type Players = Pick<Snapshot, "players" | "playerNames" | "playerGuests" | "rematch">;

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
  /** Marks a cell in ultimate tic-tac-toe. */
  tictactoe.actionSchema,
  /** Puts a stone on a cell in Hex, and Blue's swap. */
  hex.placeSchema,
  hex.swapSchema,
  /**
   * Gives up the game (D10). Not an action of the game: the server has a message of its own
   * for it, which `sendActions` sends in its place. It is here so that it goes out the way
   * actions do, one at a time, with the page waiting for the answer.
   */
  z.object({ type: z.literal("forfeit") }),
]);
export type Action = z.infer<typeof actionSchema>;

/** What `POST /api/games/{id}/join` returns. */
export const seatReplySchema = z.object({ gameId: z.string(), seat: z.number().int() });
