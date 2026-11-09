import { describe, expect, it } from "vitest";
import { board, marks, moving, snapshotOf, startingState, utttSnapshotOf, utttState } from "../../fixtures";
import {
  addFrame,
  asFrame,
  asUtttFrame,
  atFor,
  extend,
  framesOf,
  readFrame,
  hasMoves,
  hasMovesIn,
  moveForKey,
  reviewAlwaysOn,
  shownIndex,
} from "./review";
import type { Frame, UtttState } from "./schemas";

// The positions of one turn of seat 0 (White), as the server's revisions number them.
const start = startingState();
/** Rolled 6-3, nothing played. */
const rolled = startingState(moving([6, 3], [{ from: 1, die: 6 }]));
/** The 6 played from the head. */
const afterSix = startingState({
  points: [board({ 1: 14, 7: 1 }), board({ 1: 15 })],
  ...moving([6, 3], [{ from: 7, die: 3 }], [{ from: 1, die: 6 }], [3]),
});
/** The 3 played too: the turn is over and seat 1 is to roll. */
const turnOver = startingState({
  turn: 1,
  turns: [1, 0],
  points: [board({ 1: 14, 10: 1 }), board({ 1: 15 })],
  lastTurn: { seat: 0, dice: [6, 3], played: [{ from: 1, die: 6 }, { from: 7, die: 3 }] },
});
/** The game ends with the last checker. */
const over = startingState({
  turn: 0,
  off: [15, 2],
  turns: [41, 40],
  phase: { type: "over", winner: 0, points: 1, forfeited: false },
  lastTurn: { seat: 0, dice: [1, 2], played: [{ from: 24, die: 1 }] },
});

const frame = (revision: number, state = start) => asFrame(revision, state);
const revisions = (frames: readonly Frame[]) => frames.map((f) => f.revision);

describe("a frame", () => {
  it("is a position with nothing to play, whatever the server listed", () => {
    const { state, revision } = asFrame(7, rolled);

    expect(revision).toBe(7);
    expect(state.legal).toEqual([]);
    expect(state.combos).toEqual([]);
    expect(state.phase).toEqual(rolled.phase);
    expect(state.points).toEqual(rolled.points);
  });

  it("leaves the state it was made from alone", () => {
    asFrame(1, rolled);

    expect(rolled.legal).toHaveLength(1);
  });
});

describe("hasMoves", () => {
  it("is false for a game that has only just started", () => {
    expect(hasMoves(start)).toBe(false);
  });

  it("is true once the dice are rolled, a turn is over, or the game is", () => {
    expect(hasMoves(rolled)).toBe(true);
    expect(hasMoves(turnOver)).toBe(true);
    expect(hasMoves(over)).toBe(true);
  });

  it("is true after a roll that could not be played, which only shows in the turn before", () => {
    const lost = startingState({
      turn: 1,
      turns: [1, 0],
      lastTurn: { seat: 0, dice: [6, 5], played: [] },
    });

    expect(hasMoves(lost)).toBe(true);
  });
});

describe("addFrame", () => {
  it("adds a position that follows", () => {
    const frames = addFrame([frame(1), frame(2, rolled)], frame(3, afterSix));

    expect(revisions(frames)).toEqual([1, 2, 3]);
  });

  it("does not change the frames it is given", () => {
    const held = [frame(1), frame(2, rolled)];

    addFrame(held, frame(3, afterSix));

    expect(held).toHaveLength(2);
  });

  it("leaves out a step that was taken back: the position before it is the frame already there", () => {
    const held = [frame(1), frame(2, rolled), frame(3, afterSix)];

    const frames = addFrame(held, frame(4, rolled));

    expect(revisions(frames)).toEqual([1, 2]);
    expect(frames.at(-1)?.state.phase).toEqual(rolled.phase);
  });

  it("goes back one step at a time through several", () => {
    const afterBoth = startingState({
      points: [board({ 1: 14, 10: 1 }), board({ 1: 15 })],
      ...moving([6, 3], [], [{ from: 1, die: 6 }, { from: 7, die: 3 }], []),
    });
    let frames: Frame[] = [frame(1), frame(2, rolled), frame(3, afterSix), frame(4, afterBoth)];

    frames = addFrame(frames, frame(5, afterSix));
    expect(revisions(frames)).toEqual([1, 2, 3]);
    frames = addFrame(frames, frame(6, rolled));
    expect(revisions(frames)).toEqual([1, 2]);
  });

  it("keeps a step that is played again, after one was taken back", () => {
    const elsewhere = startingState({
      points: [board({ 1: 14, 4: 1 }), board({ 1: 15 })],
      ...moving([6, 3], [{ from: 4, die: 6 }], [{ from: 1, die: 3 }], [6]),
    });
    let frames: Frame[] = [frame(1), frame(2, rolled), frame(3, afterSix)];

    frames = addFrame(frames, frame(4, rolled));
    frames = addFrame(frames, frame(5, elsewhere));

    expect(revisions(frames)).toEqual([1, 2, 5]);
    const last = frames.at(-1);
    expect(last?.kind === "long-backgammon" && last.state.points[0]).toEqual(board({ 1: 14, 4: 1 }));
  });

  it("does not take a step back that is the end of a turn: it cannot be taken back", () => {
    const frames = addFrame([frame(2, rolled), frame(3, afterSix)], frame(4, turnOver));

    expect(revisions(frames)).toEqual([2, 3, 4]);
  });

  it("keeps a position that looks like a step back when there is no frame to go back to", () => {
    // The history begins in the middle of the turn, as for a game that was going when positions began to be kept.
    const frames = addFrame([frame(3, afterSix)], frame(4, rolled));

    expect(revisions(frames)).toEqual([3, 4]);
  });

  it("keeps a position that looks like a step back but whose board is not the one before", () => {
    const stray = startingState({
      points: [board({ 1: 13, 9: 2 }), board({ 1: 15 })],
      ...moving([6, 3], [], [{ from: 1, die: 6 }], [3]),
    });

    const frames = addFrame([frame(1), frame(2, rolled), frame(3, afterSix)], frame(4, stray));

    expect(revisions(frames)).toEqual([1, 2, 3, 4]);
  });
});

describe("framesOf", () => {
  it("is a game played without a step taken back, as it was", () => {
    const positions = [frame(1), frame(2, rolled), frame(3, afterSix), frame(4, turnOver)];

    expect(revisions(framesOf(positions))).toEqual([1, 2, 3, 4]);
  });

  it("leaves out the steps that were taken back, with the undo that took them back", () => {
    const positions = [
      frame(1),
      frame(2, rolled),
      frame(3, afterSix),
      frame(4, rolled), // undo
      frame(5, afterSix),
      frame(6, turnOver),
    ];

    expect(revisions(framesOf(positions))).toEqual([1, 2, 5, 6]);
  });

  it("is nothing for a game with no positions", () => {
    expect(framesOf([])).toEqual([]);
  });
});

describe("extend, for a snapshot of a game in review", () => {
  const snapshot = (revision: number, state = rolled) => snapshotOf({ revision, state });
  const held = [frame(1), frame(2, rolled)];

  it("adds the position of the next revision", () => {
    const more = extend(held, 2, snapshot(3, afterSix));

    expect(more).toMatchObject({ type: "frames", through: 3 });
    expect(more.type === "frames" && revisions(more.frames)).toEqual([1, 2, 3]);
  });

  it("adds it without what the player could press, since nothing in review is played", () => {
    const more = extend(held, 2, snapshot(3, afterSix));

    const last = more.type === "frames" ? more.frames.at(-1) : undefined;
    expect(last?.kind === "long-backgammon" && last.state.legal).toEqual([]);
  });

  it("takes a step back as the frame that was before the step, and moves on to its revision", () => {
    const frames = [frame(1), frame(2, rolled), frame(3, afterSix)];

    const more = extend(frames, 3, snapshot(4, rolled));

    expect(more).toMatchObject({ type: "frames", through: 4 });
    expect(more.type === "frames" && revisions(more.frames)).toEqual([1, 2]);
  });

  it("adds nothing for a snapshot it has, or one older, such as the same one again after a reconnect", () => {
    expect(extend(held, 2, snapshot(2))).toEqual({ type: "none" });
    expect(extend(held, 2, snapshot(1))).toEqual({ type: "none" });
  });

  it("adds nothing for a game that has not started", () => {
    expect(extend(held, 2, snapshotOf({ revision: 3, state: null }))).toEqual({ type: "none" });
  });

  it("says that positions were missed when the snapshot is more than one revision on", () => {
    expect(extend(held, 2, snapshot(5, afterSix))).toEqual({ type: "missed" });
  });

  it("adds nothing once the game is over: the revisions that follow are the rematch's", () => {
    const ended = [frame(1), frame(9, over)];

    expect(extend(ended, 9, snapshot(10, over))).toEqual({ type: "none" });
    expect(extend(ended, 9, snapshot(14, over))).toEqual({ type: "none" });
  });

  it("begins with the snapshot when there are no frames, as for a game from before positions were kept", () => {
    const more = extend([], -1, snapshot(30, afterSix));

    expect(more).toMatchObject({ type: "frames", through: 30 });
    expect(more.type === "frames" && revisions(more.frames)).toEqual([30]);
  });
});

describe("which frame is on show", () => {
  it("is the newest unless one was picked", () => {
    expect(shownIndex(5, null)).toBe(4);
    expect(shownIndex(5, 2)).toBe(2);
  });

  it("is none when there are no frames", () => {
    expect(shownIndex(0, null)).toBeNull();
    expect(shownIndex(0, 3)).toBeNull();
  });

  it("stays on the newest frame if the one picked has gone, as when a step is taken back", () => {
    expect(shownIndex(3, 7)).toBe(2);
  });

  it("is the way to ask for a frame: the newest is null, so that it follows the game", () => {
    expect(atFor(5, 4)).toBeNull();
    expect(atFor(5, 9)).toBeNull();
    expect(atFor(5, 3)).toBe(3);
    expect(atFor(5, -2)).toBe(0);
  });
});

describe("moveForKey", () => {
  it("steps with the arrows and jumps with Home and End", () => {
    expect(moveForKey("ArrowLeft")).toBe("previous");
    expect(moveForKey("ArrowRight")).toBe("next");
    expect(moveForKey("Home")).toBe("first");
    expect(moveForKey("End")).toBe("last");
  });

  it("leaves every other key alone, including the ones that scroll the page", () => {
    expect(moveForKey("ArrowDown")).toBeNull();
    expect(moveForKey(" ")).toBeNull();
    expect(moveForKey("a")).toBeNull();
  });
});

describe("reviewAlwaysOn", () => {
  const players = ["user-a", "user-b"];
  const snapshot = (state: ReturnType<typeof startingState> | null) => snapshotOf({ players, state });

  it("is on for a game that is over, for a player and for a watcher", () => {
    for (const userId of ["user-a", "user-b", "someone-else"]) {
      expect(reviewAlwaysOn(snapshot(over), userId)).toBe(true);
    }
  });

  it("is on for a user who only watches a game that has been played in", () => {
    expect(reviewAlwaysOn(snapshot(turnOver), "someone-else")).toBe(true);
    expect(reviewAlwaysOn(snapshot(rolled), "someone-else")).toBe(true);
  });

  it("is off for the players of a game in progress", () => {
    expect(reviewAlwaysOn(snapshot(turnOver), "user-a")).toBe(false);
    expect(reviewAlwaysOn(snapshot(turnOver), "user-b")).toBe(false);
  });

  it("is off before anything has been played, and before the game has started", () => {
    expect(reviewAlwaysOn(snapshot(start), "someone-else")).toBe(false);
    expect(reviewAlwaysOn(snapshot(null), "someone-else")).toBe(false);
  });

  it("is off for a user who is not known yet, who would otherwise pass for a watcher", () => {
    expect(reviewAlwaysOn(snapshot(turnOver), null)).toBe(false);
    expect(reviewAlwaysOn(snapshot(over), null)).toBe(true);
  });
});

describe("ultimate tic-tac-toe", () => {
  const fresh = utttState();
  const first = utttState({ turn: 1, last: { seat: 0, board: 4, cell: 4 }, cells: marks({ 4: { 4: 0 } }), playable: [4] });
  const second = utttState({
    turn: 0,
    last: { seat: 1, board: 4, cell: 0 },
    cells: marks({ 4: { 4: 0, 0: 1 } }),
    playable: [0],
  });
  const ended = utttState({ ...second, phase: { type: "over", winner: 1, forfeited: true }, playable: [] });
  const frameOf = (revision: number, state: UtttState) => asUtttFrame(revision, state);
  const snapshot = (revision: number, state: UtttState | null) => utttSnapshotOf({ revision, state });
  const players = ["user-a", "user-b"];

  describe("a frame", () => {
    it("is the position as it was, with the board that was to be played in next", () => {
      const frame = asUtttFrame(7, first);

      expect(frame).toEqual({ kind: "ultimate-tic-tac-toe", revision: 7, state: first });
      expect(frame.state.playable).toEqual([4]);
    });

    it("keeps the board a position sent the player to, for a game that is over as well: none", () => {
      expect(asUtttFrame(9, ended).state.playable).toEqual([]);
    });
  });

  describe("readFrame", () => {
    it("reads a position the server kept, as it was, with the board that was to be played in", () => {
      expect(readFrame("ultimate-tic-tac-toe", 4, first)).toEqual(asUtttFrame(4, first));
      expect(readFrame("ultimate-tic-tac-toe", 4, first)).toMatchObject({ state: { playable: [4] } });
    });

    it("refuses what is not a position of this game, or lacks what a frame shows", () => {
      expect(readFrame("ultimate-tic-tac-toe", 4, { ...first, cells: [] })).toBeNull();
      expect(readFrame("ultimate-tic-tac-toe", 4, { ...first, boards: undefined })).toBeNull();
      expect(readFrame("ultimate-tic-tac-toe", 4, { ...first, playable: undefined })).toBeNull();
      expect(readFrame("ultimate-tic-tac-toe", 4, null)).toBeNull();
      // A long backgammon position is not one of this game, and the other way round.
      expect(readFrame("ultimate-tic-tac-toe", 4, start)).toBeNull();
      expect(readFrame("long-backgammon", 4, first)).toBeNull();
    });
  });

  describe("hasMovesIn", () => {
    it("is false before the first mark, and true after it", () => {
      expect(hasMovesIn({ kind: "ultimate-tic-tac-toe", state: fresh })).toBe(false);
      expect(hasMovesIn({ kind: "ultimate-tic-tac-toe", state: first })).toBe(true);
    });

    it("is true for a game that was given up before any mark, which has two positions to step through", () => {
      const forfeited = utttState({ phase: { type: "over", winner: 1, forfeited: true } });

      expect(hasMovesIn({ kind: "ultimate-tic-tac-toe", state: forfeited })).toBe(true);
    });

    it("asks the game that the frame is of", () => {
      expect(hasMovesIn({ kind: "long-backgammon", state: start })).toBe(false);
      expect(hasMovesIn({ kind: "long-backgammon", state: rolled })).toBe(true);
    });
  });

  describe("addFrame", () => {
    it("keeps every position as a frame: a mark is never taken back", () => {
      let frames: Frame[] = [];
      for (const [revision, state] of [[1, fresh], [2, first], [3, second], [4, ended]] as const) {
        frames = addFrame(frames, frameOf(revision, state));
      }

      expect(frames.map((f) => f.revision)).toEqual([1, 2, 3, 4]);
    });

    it("does not mistake a mark for a step taken back, even when the board goes back to how it was", () => {
      // Two frames of the same position, as can come of a rematch being asked: both stay.
      const frames = addFrame([frameOf(1, fresh), frameOf(2, first)], frameOf(3, fresh));

      expect(frames.map((f) => f.revision)).toEqual([1, 2, 3]);
    });
  });

  describe("extend", () => {
    const held = [frameOf(1, fresh), frameOf(2, first)];

    it("adds the next snapshot as one more frame, with the board that was to be played in", () => {
      const more = extend(held, 2, snapshot(3, second));

      expect(more.type === "frames" && more.frames.map((f) => f.revision)).toEqual([1, 2, 3]);
      const last = more.type === "frames" ? more.frames.at(-1) : undefined;
      expect(last?.kind === "ultimate-tic-tac-toe" && last.state.playable).toEqual([0]);
    });

    it("asks for the positions again when some were missed", () => {
      expect(extend(held, 2, snapshot(5, second))).toEqual({ type: "missed" });
    });

    it("adds nothing after the game has ended, or for a snapshot that is not newer", () => {
      expect(extend([frameOf(1, fresh), frameOf(2, ended)], 2, snapshot(3, ended))).toEqual({ type: "none" });
      expect(extend(held, 2, snapshot(2, first))).toEqual({ type: "none" });
      expect(extend(held, 2, snapshot(3, null))).toEqual({ type: "none" });
    });

    it("begins the review at the snapshot when there are no frames", () => {
      const more = extend([], -1, snapshot(30, second));

      expect(more).toMatchObject({ type: "frames", through: 30 });
      expect(more.type === "frames" && more.frames.map((f) => f.revision)).toEqual([30]);
    });
  });

  describe("reviewAlwaysOn", () => {
    it("is on for a game that is over, and for a watcher of a game that has been played", () => {
      expect(reviewAlwaysOn(snapshot(9, ended), "user-a")).toBe(true);
      expect(reviewAlwaysOn(snapshot(9, ended), "someone-else")).toBe(true);
      expect(reviewAlwaysOn(snapshot(3, second), "someone-else")).toBe(true);
    });

    it("is off for the players of a game that is on, before a mark, and before the game starts", () => {
      expect(reviewAlwaysOn(snapshot(3, second), "user-a")).toBe(false);
      expect(reviewAlwaysOn(snapshot(1, fresh), "someone-else")).toBe(false);
      expect(reviewAlwaysOn(snapshot(1, null), "someone-else")).toBe(false);
      expect(reviewAlwaysOn(snapshot(3, second), null)).toBe(false);
      expect(players).toContain("user-a");
    });
  });
});
