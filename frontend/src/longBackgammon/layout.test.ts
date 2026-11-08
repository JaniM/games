import { describe, expect, it } from "vitest";
import { board, moving, startingState } from "../fixtures";
import { HEIGHT, WIDTH, hopVector, slotCentre } from "./geometry";
import {
  colourOf,
  destinations,
  diceFaces,
  landing,
  otherIndex,
  pointNumber,
  pointSlot,
  bearOffStep,
  pressOutcome,
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

describe("pointNumber", () => {
  it("puts White's head at 24 and its home at 6 to 1", () => {
    expect(pointNumber(1, 0, 0)).toBe(24);
    expect(pointNumber(19, 0, 0)).toBe(6);
    expect(pointNumber(24, 0, 0)).toBe(1);
  });

  it("puts Black's head at 12 and its home at 18 to 13", () => {
    expect(pointNumber(1, 1, 0)).toBe(12);
    expect(pointNumber(19, 1, 0)).toBe(18);
    expect(pointNumber(24, 1, 0)).toBe(13);
  });

  it("follows the rules doc for Black: ((12 - j) mod 24) + 1", () => {
    for (let j = 1; j <= 24; j++) {
      expect(pointNumber(j, 1, 0)).toBe((((12 - j) % 24) + 24) % 24 + 1);
    }
  });

  it("is the same number for both players, and for whoever is White", () => {
    for (const white of [0, 1] as const) {
      for (let k = 1; k <= 24; k++) {
        // Seat 0's point k is seat 1's point k + 12 (or k - 12).
        expect(pointNumber(k, 0, white)).toBe(pointNumber(otherIndex(k), 1, white));
      }
    }
  });

  it("numbers the 24 points once each", () => {
    const numbers = new Set(Array.from({ length: 24 }, (_, i) => pointNumber(i + 1, 1, 1)));
    expect(numbers.size).toBe(24);
    expect(Math.min(...numbers)).toBe(1);
    expect(Math.max(...numbers)).toBe(24);
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

describe("hopVector", () => {
  const middle = { x: WIDTH / 2, y: HEIGHT / 2 };

  it("curves down on the top side, where a trip along the top row bulges towards the middle", () => {
    const hop = hopVector(slotCentre(1, 0), slotCentre(7, 0)); // top row, towards the left

    expect(hop.y).toBeGreaterThan(0);
    expect(Math.abs(hop.x)).toBeLessThan(hop.y / 4);
  });

  it("curves up on the bottom side", () => {
    const hop = hopVector(slotCentre(13, 0), slotCentre(19, 0)); // bottom row, towards the right

    expect(hop.y).toBeLessThan(0);
    expect(Math.abs(hop.x)).toBeLessThan(-hop.y / 4);
  });

  it("curves the same way whichever direction the trip goes, since an undo goes back", () => {
    const there = hopVector(slotCentre(1, 0), slotCentre(7, 0));
    const back = hopVector(slotCentre(7, 0), slotCentre(1, 0));

    expect(back).toEqual(there);
  });

  it("curves inward round the end where a trip crosses from the top row to the bottom row", () => {
    const hop = hopVector(slotCentre(12, 2), slotCentre(13, 2)); // the far left end

    expect(hop.x).toBeGreaterThan(0);
    expect(Math.abs(hop.y)).toBeLessThan(hop.x / 2);
  });

  it("is at right angles to the trip, longer for a longer trip, within limits", () => {
    const length = (v: { x: number; y: number }) => Math.hypot(v.x, v.y);
    const short = hopVector(slotCentre(7, 0), slotCentre(6, 0));
    const long = hopVector(slotCentre(1, 0), slotCentre(7, 0));
    const very = hopVector({ x: 20, y: 60 }, { x: 700, y: 60 });

    expect(length(short)).toBeCloseTo(28, 0);
    expect(length(long)).toBeGreaterThan(length(short));
    expect(length(very)).toBeCloseTo(80, 0);
    // Right angles: no push along the trip.
    const from = slotCentre(1, 0);
    const to = slotCentre(7, 0);
    expect(long.x * (to.x - from.x) + long.y * (to.y - from.y)).toBeLessThan(
      length(long) * Math.hypot(to.x - from.x, to.y - from.y) * 0.02,
    );
  });

  it("does not push a trip that goes nowhere", () => {
    expect(hopVector(middle, middle)).toEqual({ x: 0, y: 0 });
  });
});

describe("bearOffStep", () => {
  it("bears off with the only die that can", () => {
    const ways = [{ die: 3, to: 5 }, { die: 5, to: "off" as const }];

    expect(bearOffStep(20, ways)).toEqual({ from: 20, die: 5 });
  });

  it("uses the larger die when two different dice can", () => {
    const ways = [{ die: 5, to: "off" as const }, { die: 6, to: "off" as const }];

    expect(bearOffStep(20, ways)).toEqual({ from: 20, die: 6 });
    expect(bearOffStep(20, [...ways].reverse())).toEqual({ from: 20, die: 6 });
  });

  it("is nothing when no die bears the checker off, or nothing is selected", () => {
    expect(bearOffStep(20, [{ die: 3, to: 23 }])).toBeNull();
    expect(bearOffStep(20, [])).toBeNull();
    expect(bearOffStep(null, [{ die: 5, to: "off" }])).toBeNull();
  });
});

describe("pressOutcome", () => {
  // The checker on 1 may play a 3 (to 4) or a 6 (to 7); another checker on 4 may also move.
  const ways = [
    { die: 3, to: 4 },
    { die: 6, to: 7 },
  ];
  const sources = new Set([1, 4]);

  it("moves the selected checker when the background of a landing place is pressed", () => {
    expect(pressOutcome("background", 7, 1, ways, sources)).toEqual({
      type: "move",
      step: { from: 1, die: 6 },
    });
  });

  it("selects the pieces on a landing place instead of moving there", () => {
    // Point 4 is a landing place for the 3 and also has a checker that can move.
    expect(pressOutcome("piece", 4, 1, ways, sources)).toEqual({ type: "select", point: 4 });
    // The background of the very same point is what moves.
    expect(pressOutcome("background", 4, 1, ways, sources)).toEqual({
      type: "move",
      step: { from: 1, die: 3 },
    });
  });

  it("selects when the background of a point that is no landing place has movable checkers", () => {
    expect(pressOutcome("background", 1, null, [], sources)).toEqual({ type: "select", point: 1 });
    expect(pressOutcome("background", 4, 1, [{ die: 6, to: 7 }], sources)).toEqual({
      type: "select",
      point: 4,
    });
  });

  it("does nothing for a point with nothing to start from, and never moves without a selection", () => {
    expect(pressOutcome("piece", 9, 1, ways, sources)).toEqual({ type: "none" });
    expect(pressOutcome("background", 7, null, ways, sources)).toEqual({ type: "none" });
  });
});

describe("diceFaces", () => {
  it("shows no dice before anybody has rolled", () => {
    expect(diceFaces(startingState())).toEqual([]);
  });

  it("leaves the dice of the last turn on the board, played, until the next roll", () => {
    const lastTurn = { seat: 0 as const, dice: [6, 3] as [number, number], played: [] };
    expect(diceFaces(startingState({ turn: 1, lastTurn }))).toEqual([
      { value: 6, used: true },
      { value: 3, used: true },
    ]);
    expect(diceFaces(startingState({ turn: 1, lastTurn: { ...lastTurn, dice: [4, 4] } }))).toEqual(
      Array.from({ length: 4 }, () => ({ value: 4, used: true })),
    );
    const over = startingState({ lastTurn, phase: { type: "over", winner: 0, points: 1 } });
    expect(diceFaces(over)).toHaveLength(2);
  });

  it("shows two dice, unused until played", () => {
    expect(diceFaces(startingState(moving([6, 3], [])))).toEqual([
      { value: 6, used: false },
      { value: 3, used: false },
    ]);
  });

  it("dims the die that was played", () => {
    const state = startingState(moving([6, 3], [], [{ from: 1, die: 6 }], [3]));
    expect(diceFaces(state)).toEqual([
      { value: 6, used: true },
      { value: 3, used: false },
    ]);
  });

  it("shows four dice for a double, the played ones first", () => {
    const state = startingState(moving([4, 4], [], [], [4, 4, 4]));
    expect(diceFaces(state).map((d) => d.used)).toEqual([true, false, false, false]);
  });
});
