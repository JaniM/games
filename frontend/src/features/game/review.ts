import {
  type Frame,
  type GameKind,
  LONG_BACKGAMMON,
  type LongBackgammonFrame,
  type LongBackgammonState,
  type Position,
  type Snapshot,
  ULTIMATE_TIC_TAC_TOE,
  type UtttFrame,
  type UtttState,
  positionSchema,
} from "./schemas";
import { seatOf } from "./selectors";
import { stateSchema as utttStateSchema } from "./ultimateTicTacToe";

// Reviewing a game: stepping through the positions it has been in. The server keeps every
// position (`GET /api/games/{id}/history`), the client keeps them as frames, and a game that
// is still going adds the snapshots it receives to them. The functions here are the rules
// for that, apart from any db, so that each can be tested alone.

/**
 * A long backgammon state as a frame: the position and the revision that showed it. The lists of
 * what may be played are emptied, because a position of the past is looked at, not played from.
 */
export function asFrame(revision: number, state: Position): LongBackgammonFrame {
  return { kind: LONG_BACKGAMMON, revision, state: { ...state, legal: [], combos: [] } };
}

/**
 * An ultimate tic-tac-toe state as a frame. Nothing is left out: `playable` says which board was
 * to be played in, which is part of how the position looked, and is shown. A frame is not pressed,
 * which the screen sees to (the board of a review is not interactive).
 */
export function asUtttFrame(revision: number, state: UtttState): UtttFrame {
  return { kind: ULTIMATE_TIC_TAC_TOE, revision, state };
}

/** A state with the kind of game it is a state of: what a snapshot and a frame both hold. */
export type Positioned = Pick<LongBackgammonFrame, "kind" | "state"> | Pick<UtttFrame, "kind" | "state">;

/** The state of a snapshot with its kind, or null for a game that has no state yet. */
export function positionOf(snapshot: Snapshot): Positioned | null {
  switch (snapshot.kind) {
    case LONG_BACKGAMMON:
      return snapshot.state && { kind: snapshot.kind, state: snapshot.state };
    case ULTIMATE_TIC_TAC_TOE:
      return snapshot.state && { kind: snapshot.kind, state: snapshot.state };
  }
}

/** The frame that shows `position`, as the game was at `revision`. */
export function frameOf(revision: number, position: Positioned): Frame {
  switch (position.kind) {
    case LONG_BACKGAMMON:
      return asFrame(revision, position.state);
    case ULTIMATE_TIC_TAC_TOE:
      return asUtttFrame(revision, position.state);
  }
}

/**
 * A position from the server's history as a frame, or null if it is not a position of a game of
 * `kind` in the layout this client reads.
 */
export function readFrame(kind: GameKind, revision: number, state: unknown): Frame | null {
  switch (kind) {
    case LONG_BACKGAMMON: {
      const position = positionSchema.safeParse(state);
      return position.success ? asFrame(revision, position.data) : null;
    }
    case ULTIMATE_TIC_TAC_TOE: {
      const position = utttStateSchema.safeParse(state);
      return position.success ? asUtttFrame(revision, position.data) : null;
    }
  }
}

/** Whether anything has been played yet: a roll, or a finished turn. Before it there is nothing to step through. */
export function hasMoves(state: LongBackgammonState): boolean {
  return state.phase.type !== "roll" || state.lastTurn !== null;
}

/** Whether anything has been played yet: a mark, or a forfeit. */
export function utttHasMoves(state: UtttState): boolean {
  return state.last !== null || state.phase.type !== "play";
}

/** Whether anything has been played yet in a game of either kind. */
export function hasMovesIn(game: Positioned): boolean {
  switch (game.kind) {
    case LONG_BACKGAMMON:
      return hasMoves(game.state);
    case ULTIMATE_TIC_TAC_TOE:
      return utttHasMoves(game.state);
  }
}

/**
 * Whether the review of a game is always there, and can't be closed: a game that is over, and a
 * game that `userId` is only watching. Both have nothing else under the board that the review
 * would be in the way of: a player of a game in progress has the turn to play, and opens the
 * review when they want to look back. Not before anything has been played, and not for a user
 * who isn't known yet, who would be taken for a watcher.
 */
export function reviewAlwaysOn(snapshot: Snapshot, userId: string | null): boolean {
  const position = positionOf(snapshot);
  if (position === null || !hasMovesIn(position)) return false;
  if (position.state.phase.type === "over") return true;
  return userId !== null && seatOf(snapshot, userId) === null;
}

/** Whether `after` is `before` with the last step of the turn taken back (the `undo` action). */
function isTakenBack(before: LongBackgammonState, after: LongBackgammonState): boolean {
  const { phase: was } = before;
  const { phase: is } = after;
  return (
    was.type === "move" &&
    is.type === "move" &&
    before.turn === after.turn &&
    is.played.length === was.played.length - 1 &&
    is.remaining.length === was.remaining.length + 1
  );
}

/** Whether the checkers stand the same in both. */
function sameBoard(a: LongBackgammonState, b: LongBackgammonState): boolean {
  return (
    a.off[0] === b.off[0] &&
    a.off[1] === b.off[1] &&
    a.points.every((side, seat) => side.every((count, point) => count === b.points[seat]?.[point]))
  );
}

/**
 * The frames after the game reaches `next`. A step that is taken back is not part of the game
 * as it was played, so it is left out: the frame it made goes, and `next`, which shows the
 * position before it, is the frame that is already there. Anything else is one more frame.
 *
 * It looks before it takes anything out. A history that begins in the middle of a turn (a
 * game that was going when positions began to be kept) has no frame to go back to, and then
 * `next` is kept as a frame of its own.
 *
 * Only long backgammon has steps to take back. In ultimate tic-tac-toe a mark is final (D9), so
 * every position is a frame.
 */
export function addFrame(frames: readonly Frame[], next: Frame): Frame[] {
  const last = frames.at(-1);
  const before = frames.at(-2);
  if (
    last?.kind === LONG_BACKGAMMON &&
    before?.kind === LONG_BACKGAMMON &&
    next.kind === LONG_BACKGAMMON &&
    isTakenBack(last.state, next.state) &&
    sameBoard(before.state, next.state)
  ) {
    return frames.slice(0, -1);
  }
  return [...frames, next];
}

/** The frames of a game, from the positions the server kept, oldest first. */
export function framesOf(positions: readonly Frame[]): Frame[] {
  return positions.reduce<Frame[]>((frames, position) => addFrame(frames, position), []);
}

/** What a snapshot adds to the frames held. */
export type Extension =
  /** Nothing: the snapshot is not newer, or nothing comes after the end of the game. */
  | { type: "none" }
  /** The frames to hold now, and the revision they go up to. */
  | { type: "frames"; frames: Frame[]; through: number }
  /** Positions in between were missed, so the server has to be asked again. */
  | { type: "missed" };

/**
 * Takes a live snapshot into frames that go `through` a revision (-1 for none yet).
 *
 * While a game is played every revision is a new position, so the next snapshot is the revision
 * after `through`. A later one means some were missed: the socket skips to the newest when the
 * reader is slow, and starts over when it reconnects. After the end of the game the revisions
 * go on (a rematch is asked for and answered) with the same position, which is not a frame.
 *
 * With no frames at all, as for a game that was played before positions were kept, the snapshot
 * is where the review begins.
 */
export function extend(frames: readonly Frame[], through: number, snapshot: Snapshot): Extension {
  const { revision } = snapshot;
  const position = positionOf(snapshot);
  if (!position || revision <= through) return { type: "none" };
  const last = frames.at(-1);
  if (last?.state.phase.type === "over") return { type: "none" };
  if (!last) return { type: "frames", frames: [frameOf(revision, position)], through: revision };
  if (revision !== through + 1) return { type: "missed" };
  return { type: "frames", frames: addFrame(frames, frameOf(revision, position)), through: revision };
}

/** The index of the frame to show: the one picked, else the newest. Null when there are no frames. */
export function shownIndex(count: number, at: number | null): number | null {
  if (count === 0) return null;
  return Math.max(0, Math.min(at ?? count - 1, count - 1));
}

/**
 * The `at` that shows frame `index` of `count`. The newest is `null`, which stays the newest
 * as a game that is still going adds frames; anything past the ends is the end.
 */
export function atFor(count: number, index: number): number | null {
  return index >= count - 1 ? null : Math.max(0, index);
}

/** What a key does in a review. */
export type ReviewMove = "first" | "previous" | "next" | "last";

/** The step a key asks for, or null for a key that is not for the review. */
export function moveForKey(key: string): ReviewMove | null {
  switch (key) {
    case "ArrowLeft":
      return "previous";
    case "ArrowRight":
      return "next";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return null;
  }
}
