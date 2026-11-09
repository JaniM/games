import { describe, expect, it } from "vitest";
import { marks, utttSnapshotOf, utttState, wonBoard } from "../fixtures";
import {
  boardLabel,
  boardsWon,
  cellLabel,
  frameText,
  markName,
  markOf,
  placeText,
  resultOf,
  turnText,
  viewerSeat,
} from "./status";

const over = (winner: 0 | 1 | null, forfeited = false) =>
  utttState({ phase: { type: "over", winner, forfeited }, last: { seat: 0, board: 4, cell: 2 } });

describe("marks", () => {
  it("gives X to the seat that moves first", () => {
    expect(markOf(utttState({ x: 0 }), 0)).toBe("x");
    expect(markOf(utttState({ x: 0 }), 1)).toBe("o");
    expect(markOf(utttState({ x: 1 }), 0)).toBe("o");
    expect(markOf(utttState({ x: 1 }), 1)).toBe("x");
  });

  it("names them as capitals", () => {
    expect(markName("x")).toBe("X");
    expect(markName("o")).toBe("O");
  });
});

describe("the viewer", () => {
  it("is the player's own seat", () => {
    expect(viewerSeat(1, utttState({ x: 0 }))).toBe(1);
  });

  it("is X's seat for someone who only watches, and seat 0 before there is a game", () => {
    expect(viewerSeat(null, utttState({ x: 1 }))).toBe(1);
    expect(viewerSeat(null, null)).toBe(0);
  });
});

describe("boardsWon", () => {
  it("counts the boards each seat holds, not the drawn ones", () => {
    const state = utttState({
      cells: marks({
        0: wonBoard(0),
        1: wonBoard(0, [0, 4, 8]),
        2: wonBoard(1),
        // Full with no line: drawn.
        3: { 0: 0, 1: 1, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 0, 8: 0 },
      }),
    });

    expect(boardsWon(state, 0)).toBe(2);
    expect(boardsWon(state, 1)).toBe(1);
  });

  it("is none at the start", () => {
    expect(boardsWon(utttState(), 0)).toBe(0);
  });
});

describe("placeText", () => {
  it("counts from 1, as the rules do", () => {
    expect(placeText(0, 0)).toBe("cell 1 of board 1");
    expect(placeText(4, 2)).toBe("cell 3 of board 5");
    expect(placeText(8, 8)).toBe("cell 9 of board 9");
  });
});

describe("turnText", () => {
  it("waits for an opponent while there is no game", () => {
    const snapshot = utttSnapshotOf({ players: ["user-a"], playerNames: ["Ada"], state: null });

    expect(turnText(snapshot, 0)).toBe("Waiting for an opponent to join.");
  });

  it("tells the player with the first move that they may play anywhere", () => {
    expect(turnText(utttSnapshotOf(), 0)).toBe("Your turn. Play anywhere.");
  });

  it("sends a player to the highlighted board when there is only one", () => {
    const state = utttState({ turn: 1, last: { seat: 0, board: 0, cell: 4 }, playable: [4] });

    expect(turnText(utttSnapshotOf({ state }), 1)).toBe("Your turn. Play in the highlighted board.");
  });

  it("says why a player may play in any board, when they were sent to one that is decided", () => {
    const state = utttState({
      turn: 1,
      last: { seat: 0, board: 0, cell: 4 },
      cells: marks({ 4: wonBoard(0) }),
    });

    expect(state.playable).toHaveLength(8);
    expect(turnText(utttSnapshotOf({ state }), 1)).toBe(
      "Your turn. That board is decided, so you may play in any open board.",
    );
  });

  it("waits for the player to move, by name", () => {
    const state = utttState({ turn: 1, last: { seat: 0, board: 0, cell: 4 }, playable: [4] });

    expect(turnText(utttSnapshotOf({ state }), 0)).toBe("Waiting for Grace to play.");
    expect(turnText(utttSnapshotOf({ state }), null)).toBe("Waiting for Grace to play.");
  });

  it("says nothing when the game is over", () => {
    expect(turnText(utttSnapshotOf({ state: over(0) }), 0)).toBe("");
  });
});

describe("resultOf", () => {
  it("is null while the game is on, and before it starts", () => {
    expect(resultOf(utttSnapshotOf(), 0)).toBeNull();
    expect(resultOf(utttSnapshotOf({ state: null }), 0)).toBeNull();
  });

  it("is a win by three boards in a row, for the winner and for the loser", () => {
    const snapshot = utttSnapshotOf({ state: over(0) });

    expect(resultOf(snapshot, 0)).toEqual({
      title: "You won",
      detail: "Three boards in a row",
      forfeited: false,
      won: true,
    });
    expect(resultOf(snapshot, 1)).toEqual({
      title: "Ada won",
      detail: "Three boards in a row",
      forfeited: false,
      won: false,
    });
  });

  it("is a win by name for someone who watches, and nobody's win", () => {
    expect(resultOf(utttSnapshotOf({ state: over(1) }), null)).toMatchObject({ title: "Grace won", won: false });
  });

  it("is a draw, which nobody won", () => {
    expect(resultOf(utttSnapshotOf({ state: over(null) }), 0)).toEqual({
      title: "Draw",
      detail: "No one got three boards in a row",
      forfeited: false,
      won: false,
    });
  });

  it("says who gave up, and not what it was worth", () => {
    const snapshot = utttSnapshotOf({ state: over(0, true) });

    expect(resultOf(snapshot, 0)).toEqual({ title: "You won", detail: "Grace forfeited", forfeited: true, won: true });
    expect(resultOf(snapshot, 1)).toEqual({ title: "Ada won", detail: "You forfeited", forfeited: true, won: false });
  });
});

describe("frameText", () => {
  const snapshot = utttSnapshotOf();

  it("is the start of the game before a mark", () => {
    expect(frameText(snapshot, utttState(), 0)).toEqual({ title: "Start of the game", detail: "" });
  });

  it("is the mark that was just placed, by whoever placed it", () => {
    const state = utttState({ turn: 1, last: { seat: 0, board: 4, cell: 2 } });

    expect(frameText(snapshot, state, 1).title).toBe("Ada marked cell 3 of board 5");
    expect(frameText(snapshot, state, 0).title).toBe("You marked cell 3 of board 5");
  });

  it("says how the game ended, once it has", () => {
    expect(frameText(snapshot, over(0), 1)).toEqual({
      title: "Ada marked cell 3 of board 5",
      detail: "Game over. Ada won, three boards in a row.",
    });
    expect(frameText(snapshot, over(null), 0).detail).toBe("Game over. Draw, no one got three boards in a row.");
  });

  it("says who gave up", () => {
    expect(frameText(snapshot, over(1, true), 1).detail).toBe("Game over. You won, Ada forfeited.");
    expect(frameText(snapshot, over(0, true), 0).detail).toBe("Game over. You won, Grace forfeited.");
  });

  it("is a forfeit before any mark, which still has the start of the game as its position", () => {
    const state = utttState({ phase: { type: "over", winner: 0, forfeited: true } });

    expect(frameText(snapshot, state, 0)).toEqual({
      title: "Start of the game",
      detail: "Game over. You won, Grace forfeited.",
    });
  });
});

describe("labels for a screen reader", () => {
  const state = utttState({
    cells: marks({ 0: wonBoard(0), 1: { 4: 1 }, 2: { 0: 0, 1: 1, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 0, 8: 0 } }),
  });

  it("says how a board stands", () => {
    expect(boardLabel(state, 0)).toBe("Board 1, won by X");
    expect(boardLabel(state, 1)).toBe("Board 2");
    expect(boardLabel(state, 2)).toBe("Board 3, drawn");
  });

  it("says who won a board by their mark, not their seat", () => {
    expect(boardLabel({ ...state, x: 1 }, 0)).toBe("Board 1, won by O");
  });

  it("says what is in a cell", () => {
    expect(cellLabel(state, 1, 4)).toBe("cell 5 of board 2, O");
    expect(cellLabel(state, 0, 0)).toBe("cell 1 of board 1, X");
    expect(cellLabel(state, 3, 3)).toBe("cell 4 of board 4, empty");
  });
});
