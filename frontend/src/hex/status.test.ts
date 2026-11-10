import { describe, expect, it } from "vitest";
import { hexSnapshotOf, hexState, stones } from "../fixtures";
import { cellLabel, cellName, colourOf, frameText, resultOf, turnText, viewerSeat } from "./status";

// Seats: user-a (Ada) is seat 0, user-b (Grace) is seat 1. Seat 0 is Red unless a test says not.

const opened = hexState({
  cells: stones({ f6: 0 }),
  turn: 1,
  last: { seat: 0, column: 5, row: 5, swap: false },
  canSwap: true,
});

describe("colours", () => {
  it("gives Red to the seat that moves first", () => {
    expect(colourOf(hexState({ red: 0 }), 0)).toBe("red");
    expect(colourOf(hexState({ red: 0 }), 1)).toBe("blue");
    expect(colourOf(hexState({ red: 1 }), 1)).toBe("red");
  });
});

describe("the viewer", () => {
  it("is the player's own seat, or Red's for someone who watches", () => {
    expect(viewerSeat(1, hexState())).toBe(1);
    expect(viewerSeat(null, hexState({ red: 1 }))).toBe(1);
    expect(viewerSeat(null, null)).toBe(0);
  });
});

describe("cellName", () => {
  it("names a cell as the rules do", () => {
    expect(cellName(0, 0)).toBe("a1");
    expect(cellName(5, 5)).toBe("f6");
    expect(cellName(10, 10)).toBe("k11");
    expect(cellName(8, 0)).toBe("i1");
  });
});

describe("turnText", () => {
  it("waits for an opponent while there is no game", () => {
    expect(turnText(hexSnapshotOf({ state: null }), 0)).toBe("Waiting for an opponent to join.");
  });

  it("tells the player to move which edges are theirs to join", () => {
    expect(turnText(hexSnapshotOf(), 0)).toBe("Your turn. Join the top and bottom edges.");
    const blue = hexState({ turn: 1, cells: stones({ f6: 0, a1: 1, b2: 0 }) });
    expect(turnText(hexSnapshotOf({ state: blue }), 1)).toBe("Your turn. Join the left and right edges.");
  });

  it("offers Blue the swap on Blue's first turn", () => {
    expect(turnText(hexSnapshotOf({ state: opened }), 1)).toBe(
      "Your turn. Place a stone, or swap to make Red's stone yours.",
    );
  });

  it("waits for the player to move, by name, for a player and for someone who watches", () => {
    expect(turnText(hexSnapshotOf({ state: opened }), 0)).toBe("Waiting for Grace to play.");
    expect(turnText(hexSnapshotOf({ state: opened }), null)).toBe("Waiting for Grace to play.");
  });

  it("says nothing when the game is over", () => {
    const over = hexState({ phase: { type: "over", winner: 0, forfeited: true } });
    expect(turnText(hexSnapshotOf({ state: over }), 0)).toBe("");
  });
});

describe("resultOf", () => {
  it("is null while the game is on, and before it starts", () => {
    expect(resultOf(hexSnapshotOf(), 0)).toBeNull();
    expect(resultOf(hexSnapshotOf({ state: null }), 0)).toBeNull();
  });

  it("is a win by joining the winner's edges, for the winner and for the loser", () => {
    const won = hexState({ phase: { type: "over", winner: 1, forfeited: false } });

    expect(resultOf(hexSnapshotOf({ state: won }), 1)).toEqual({
      title: "You won",
      detail: "Joined the left and right edges",
      forfeited: false,
      won: true,
    });
    expect(resultOf(hexSnapshotOf({ state: won }), 0)).toMatchObject({ title: "Grace won", won: false });
  });

  it("says who gave up", () => {
    const given = hexState({ phase: { type: "over", winner: 0, forfeited: true } });

    expect(resultOf(hexSnapshotOf({ state: given }), null)).toEqual({
      title: "Ada won",
      detail: "Grace forfeited",
      forfeited: true,
      won: false,
    });
  });
});

describe("frameText", () => {
  const snapshot = hexSnapshotOf();

  it("is the start of the game before a stone", () => {
    expect(frameText(snapshot, hexState(), 0)).toEqual({ title: "Start of the game", detail: "" });
  });

  it("is the stone that was just placed, by whoever placed it", () => {
    expect(frameText(snapshot, opened, 1).title).toBe("Ada placed a stone on f6");
    expect(frameText(snapshot, opened, 0).title).toBe("You placed a stone on f6");
  });

  it("says where a swap put the stone", () => {
    const swapped = hexState({ cells: stones({ e4: 1 }), swapped: true, last: { seat: 1, column: 4, row: 3, swap: true } });

    expect(frameText(snapshot, swapped, 0).title).toBe("Grace swapped: Red's stone is now Blue's, on e4");
  });

  it("says how the game ended, once it has", () => {
    const won = hexState({ ...opened, phase: { type: "over", winner: 0, forfeited: false } });

    expect(frameText(snapshot, won, null).detail).toMatch(/^Game over\. Ada won/);
  });
});

describe("cellLabel", () => {
  it("names the cell and what is on it, by colour", () => {
    const state = hexState({ red: 1, cells: stones({ f6: 1, a1: 0 }) });

    expect(cellLabel(state, 5, 5)).toBe("f6, Red");
    expect(cellLabel(state, 0, 0)).toBe("a1, Blue");
    expect(cellLabel(state, 10, 10)).toBe("k11, empty");
  });
});
