import { describe, expect, it } from "vitest";
import { board, moving, startingState } from "../fixtures";
import {
  colourOf,
  destinations,
  diceFaces,
  landing,
  otherIndex,
  pointSlot,
  sourcePoints,
  toViewerIndex,
  viewerPoints,
} from "./layout";

describe("point numbers", () => {
  it("are the other player's plus or minus twelve", () => {
    expect(otherIndex(1)).toBe(13);
    expect(otherIndex(12)).toBe(24);
    expect(otherIndex(13)).toBe(1);
    expect(otherIndex(24)).toBe(12);
  });

  it("are the same for the viewer's own seat, and translated for the other", () => {
    expect(toViewerIndex(5, 0, 0)).toBe(5);
    expect(toViewerIndex(5, 1, 0)).toBe(17);
    expect(toViewerIndex(20, 1, 0)).toBe(8);
  });
});

describe("viewerPoints", () => {
  it("shows the starting position before the game starts: heads in opposite corners", () => {
    const points = viewerPoints(null, 0);

    expect(points).toHaveLength(24);
    expect(points[0]).toEqual({ index: 1, owner: "me", count: 15 });
    expect(points[12]).toEqual({ index: 13, owner: "them", count: 15 });
    expect(points.filter((p) => p.owner !== null)).toHaveLength(2);
  });

  it("puts the opponent's checkers where the viewer counts them", () => {
    // Seat 1 has three checkers on its own point 20, which seat 0 calls point 8.
    const state = startingState({ points: [board({ 1: 15 }), board({ 1: 12, 20: 3 })] });

    const points = viewerPoints(state, 0);

    expect(points[7]).toEqual({ index: 8, owner: "them", count: 3 });
    expect(points[12]).toEqual({ index: 13, owner: "them", count: 12 });
  });

  it("draws the same position the other way round for the other seat", () => {
    const state = startingState({ points: [board({ 4: 15 }), board({ 1: 15 })] });

    const forZero = viewerPoints(state, 0);
    const forOne = viewerPoints(state, 1);

    expect(forZero[3]).toMatchObject({ owner: "me", count: 15 });
    expect(forOne[15]).toMatchObject({ index: 16, owner: "them", count: 15 });
    expect(forOne[0]).toMatchObject({ index: 1, owner: "me", count: 15 });
  });
});

describe("pointSlot", () => {
  it("puts the head top right and runs right to left along the top", () => {
    expect(pointSlot(1)).toEqual({ row: "top", column: 11 });
    expect(pointSlot(12)).toEqual({ row: "top", column: 0 });
  });

  it("runs left to right along the bottom, ending bottom right", () => {
    expect(pointSlot(13)).toEqual({ row: "bottom", column: 0 });
    expect(pointSlot(24)).toEqual({ row: "bottom", column: 11 });
  });

  it("puts the home, 19 to 24, in the bottom right quadrant", () => {
    for (let k = 19; k <= 24; k++) {
      const { row, column } = pointSlot(k);
      expect(row).toBe("bottom");
      expect(column).toBeGreaterThanOrEqual(6);
    }
  });

  it("gives every point its own slot", () => {
    const slots = new Set(Array.from({ length: 24 }, (_, i) => JSON.stringify(pointSlot(i + 1))));
    expect(slots.size).toBe(24);
  });
});

describe("colourOf", () => {
  it("is White for the seat that moves first", () => {
    const state = startingState({ white: 1 });
    expect(colourOf(1, state, 0)).toBe("white");
    expect(colourOf(0, state, 0)).toBe("black");
  });

  it("shows the viewer as White until the game has started", () => {
    expect(colourOf(0, null, 0)).toBe("white");
    expect(colourOf(1, null, 0)).toBe("black");
  });
});

describe("the ways to move", () => {
  const state = startingState({
    ...moving([6, 3], [
      { from: 1, die: 6 },
      { from: 1, die: 3 },
      { from: 20, die: 6 },
      { from: 20, die: 5 },
      { from: 22, die: 3 },
    ]),
  });

  it("starts from the points the server lists, once each", () => {
    expect([...sourcePoints(state)].sort((a, b) => a - b)).toEqual([1, 20, 22]);
  });

  it("lands on the point the die reaches", () => {
    expect(destinations(state, 1)).toEqual([
      { die: 3, to: 4 },
      { die: 6, to: 7 },
    ]);
  });

  it("bears off from 25 on, and offers each die that does it", () => {
    expect(landing({ from: 22, die: 3 })).toBe("off");
    expect(landing({ from: 24, die: 1 })).toBe("off");
    expect(landing({ from: 20, die: 6 })).toBe("off");
    expect(landing({ from: 20, die: 4 })).toBe(24);
    expect(destinations(state, 20)).toEqual([
      { die: 5, to: "off" },
      { die: 6, to: "off" },
    ]);
  });

  it("offers nothing from a point with no legal step", () => {
    expect(destinations(state, 5)).toEqual([]);
  });
});

describe("diceFaces", () => {
  it("shows no dice before a roll or after the game", () => {
    expect(diceFaces({ type: "roll" })).toEqual([]);
    expect(diceFaces({ type: "over", winner: 0, points: 1 })).toEqual([]);
  });

  it("shows two dice, unused until played", () => {
    const { phase } = moving([6, 3], []);
    expect(diceFaces(phase)).toEqual([
      { value: 6, used: false },
      { value: 3, used: false },
    ]);
  });

  it("dims the die that was played", () => {
    const { phase } = moving([6, 3], [], [{ from: 1, die: 6 }], [3]);
    expect(diceFaces(phase)).toEqual([
      { value: 6, used: true },
      { value: 3, used: false },
    ]);
  });

  it("shows four dice for a double, the played ones first", () => {
    const { phase } = moving([4, 4], [], [], [4, 4, 4]);
    expect(diceFaces(phase).map((d) => d.used)).toEqual([true, false, false, false]);
  });
});
