import { describe, expect, it } from "vitest";
import {
  hexSnapshotOf,
  hexState,
  marks,
  moving,
  snapshotOf,
  startingState,
  stones,
  utttSnapshotOf,
  utttState,
  wonBoard,
} from "../../fixtures";
import { autoplayAction } from "./autoplay";

// Seats: user-a is seat 0 (White, to move in a fresh game), user-b is seat 1.
const legal = [
  { from: 1, die: 6 },
  { from: 1, die: 3 },
  { from: 5, die: 3 },
];
const rolled = snapshotOf({ state: startingState(moving([6, 3], legal)) });

/** A random source that returns the given numbers in turn. */
const sequence = (...values: number[]) => {
  let next = 0;
  return () => values[next++ % values.length] ?? 0;
};

describe("what auto-play does", () => {
  it("rolls when it is time to roll", () => {
    expect(autoplayAction(snapshotOf(), "user-a")).toEqual({ type: "roll" });
  });

  it("takes a checker off the head whenever a legal step from the head exists", () => {
    // Two of the three legal steps start on the head (point 1); the third is another checker.
    expect(autoplayAction(rolled, "user-a", sequence(0))).toEqual({ type: "move", from: 1, die: 6 });
    expect(autoplayAction(rolled, "user-a", sequence(0.99))).toEqual({ type: "move", from: 1, die: 3 });
    for (let i = 0; i < 200; i++) {
      expect(autoplayAction(rolled, "user-a")).toMatchObject({ type: "move", from: 1 });
    }
  });

  it("chooses among the steps off the head equally, not among all of them", () => {
    const firstHalf = autoplayAction(rolled, "user-a", sequence(0.49));
    const secondHalf = autoplayAction(rolled, "user-a", sequence(0.5));

    expect(firstHalf).toEqual({ type: "move", from: 1, die: 6 });
    expect(secondHalf).toEqual({ type: "move", from: 1, die: 3 });
  });

  it("plays any legal step, equally likely, when none starts on the head", () => {
    const away = snapshotOf({
      state: startingState(moving([6, 3], [{ from: 5, die: 3 }, { from: 8, die: 6 }, { from: 8, die: 3 }])),
    });

    expect(autoplayAction(away, "user-a", sequence(0))).toEqual({ type: "move", from: 5, die: 3 });
    expect(autoplayAction(away, "user-a", sequence(0.5))).toEqual({ type: "move", from: 8, die: 6 });
    expect(autoplayAction(away, "user-a", sequence(0.99))).toEqual({ type: "move", from: 8, die: 3 });
  });

  it("only ever picks what the server listed", () => {
    for (let i = 0; i < 200; i++) {
      const action = autoplayAction(rolled, "user-a");
      expect(action).toMatchObject({ type: "move" });
      expect(legal).toContainEqual({ from: (action as { from: number }).from, die: (action as { die: number }).die });
    }
  });

  it("does nothing when it is not the player's turn", () => {
    expect(autoplayAction(rolled, "user-b")).toBeNull();
    expect(autoplayAction(snapshotOf(), "user-b")).toBeNull();
  });

  it("does nothing for a spectator or before the user is known", () => {
    expect(autoplayAction(rolled, "somebody-else")).toBeNull();
    expect(autoplayAction(rolled, null)).toBeNull();
  });

  it("does nothing before the game starts, once it is over, or with no step to play", () => {
    expect(autoplayAction(snapshotOf({ state: null }), "user-a")).toBeNull();
    const over = startingState({ phase: { type: "over", winner: 0, points: 1, forfeited: false } });
    expect(autoplayAction(snapshotOf({ state: over }), "user-a")).toBeNull();
    const stuck = startingState(moving([6, 3], []));
    expect(autoplayAction(snapshotOf({ state: stuck }), "user-a")).toBeNull();
  });

  it("plays for the other seat when that is whose turn it is", () => {
    const state = startingState({ turn: 1 });
    expect(autoplayAction(snapshotOf({ state }), "user-b")).toEqual({ type: "roll" });
    expect(autoplayAction(snapshotOf({ state }), "user-a")).toBeNull();
  });
});

describe("what auto-play does in ultimate tic-tac-toe", () => {
  // Seats: user-a is seat 0 (X, to move in a fresh game), user-b is seat 1.
  /** Seat 0 marked cell 4 of board 0, which sends seat 1 to board 4. */
  const sent = utttSnapshotOf({
    state: utttState({
      turn: 1,
      last: { seat: 0, board: 0, cell: 4 },
      cells: marks({ 0: { 4: 0 }, 4: { 0: 0, 8: 1 } }),
      playable: [4],
    }),
  });
  /** The cells of board 4 that are empty. */
  const empty = [1, 2, 3, 4, 5, 6, 7];

  it("plays anywhere at the start of the game, when every cell is open", () => {
    expect(autoplayAction(utttSnapshotOf(), "user-a", sequence(0))).toEqual({ type: "play", board: 0, cell: 0 });
    expect(autoplayAction(utttSnapshotOf(), "user-a", sequence(0.99))).toEqual({
      type: "play",
      board: 8,
      cell: 8,
    });
  });

  it("plays an empty cell of the board it was sent to, each equally likely", () => {
    const picks = empty.map((_, index) => autoplayAction(sent, "user-b", sequence((index + 0.5) / empty.length)));

    expect(picks).toEqual(empty.map((cell) => ({ type: "play", board: 4, cell })));
  });

  it("only ever picks what the server allows: a listed board, a cell with no mark", () => {
    for (let i = 0; i < 300; i++) {
      expect(autoplayAction(sent, "user-b")).toMatchObject({ type: "play", board: 4 });
      const action = autoplayAction(sent, "user-b") as { board: number; cell: number };
      expect(empty).toContain(action.cell);
    }
  });

  it("plays in any open board when the one it was sent to is decided, and never in a decided one", () => {
    const state = utttState({
      turn: 1,
      last: { seat: 0, board: 0, cell: 4 },
      cells: marks({ 4: wonBoard(0), 0: { 4: 0 }, 1: wonBoard(1) }),
    });
    const free = utttSnapshotOf({ state });
    const boards = new Set<number>();

    for (let i = 0; i < 500; i++) {
      const action = autoplayAction(free, "user-b") as { board: number; cell: number };
      boards.add(action.board);
      expect(state.cells[action.board]?.[action.cell]).toBeNull();
    }

    expect(boards.has(4)).toBe(false);
    expect(boards.has(1)).toBe(false);
    expect(boards.size).toBeGreaterThan(3);
  });

  it("does nothing when it is not the player's turn, for a spectator, or before the user is known", () => {
    expect(autoplayAction(sent, "user-a")).toBeNull();
    expect(autoplayAction(sent, "somebody-else")).toBeNull();
    expect(autoplayAction(sent, null)).toBeNull();
  });

  it("does nothing before the game starts, or once it is over", () => {
    expect(autoplayAction(utttSnapshotOf({ state: null }), "user-a")).toBeNull();
    const over = utttState({ phase: { type: "over", winner: 0, forfeited: false } });
    expect(over.playable).toEqual([]);
    expect(autoplayAction(utttSnapshotOf({ state: over }), "user-a")).toBeNull();
  });

  it("does nothing when the server lists nothing to play", () => {
    const stuck = utttState({ playable: [] });

    expect(autoplayAction(utttSnapshotOf({ state: stuck }), "user-a")).toBeNull();
  });
});

describe("what auto-play does in Hex", () => {
  const opened = hexState({
    cells: stones({ f6: 0 }),
    turn: 1,
    last: { seat: 0, column: 5, row: 5, swap: false },
    canSwap: true,
  });

  it("places a stone on any empty cell, every one as likely", () => {
    const first = autoplayAction(hexSnapshotOf(), "user-a", sequence(0));
    const last = autoplayAction(hexSnapshotOf(), "user-a", sequence(0.9999));

    expect(first).toEqual({ type: "place", column: 0, row: 0 });
    expect(last).toEqual({ type: "place", column: 10, row: 10 });
  });

  it("never plays on a stone, and swaps as one choice among the cells when it may", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const action = autoplayAction(hexSnapshotOf({ state: opened }), "user-b");
      expect(action).not.toEqual({ type: "place", column: 5, row: 5 });
      seen.add(JSON.stringify(action));
    }
    // The 120 empty cells and the swap.
    expect(seen.size).toBe(121);
    expect(seen.has(JSON.stringify({ type: "swap" }))).toBe(true);
    // The swap is the last choice.
    expect(autoplayAction(hexSnapshotOf({ state: opened }), "user-b", sequence(0.9999))).toEqual({ type: "swap" });
  });

  it("does not swap when it may not", () => {
    for (let i = 0; i < 500; i++) {
      expect(autoplayAction(hexSnapshotOf(), "user-a")).toMatchObject({ type: "place" });
    }
  });

  it("does nothing out of turn, for a spectator, before the game starts, or once it is over", () => {
    expect(autoplayAction(hexSnapshotOf({ state: opened }), "user-a")).toBeNull();
    expect(autoplayAction(hexSnapshotOf({ state: opened }), "somebody-else")).toBeNull();
    expect(autoplayAction(hexSnapshotOf({ state: null }), "user-a")).toBeNull();
    const over = hexState({ phase: { type: "over", winner: 0, forfeited: true } });
    expect(autoplayAction(hexSnapshotOf({ state: over }), "user-a")).toBeNull();
  });
});
