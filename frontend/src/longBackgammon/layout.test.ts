import { describe, expect, it } from "vitest";
import { board, moving, startingState } from "../fixtures";
import { HEIGHT, WIDTH, hopVector, slabCentre, slotCentre } from "./geometry";
import {
  type Destination,
  colourOf,
  destinations,
  diceFaces,
  diceWords,
  landing,
  otherIndex,
  pointNumber,
  pointSlot,
  bearOffSteps,
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
      { pips: 3, to: 4, steps: [{ from: 1, die: 3 }] },
      { pips: 6, to: 7, steps: [{ from: 1, die: 6 }] },
    ]);
  });

  it("bears off from 25 on, and offers each die that does it", () => {
    expect(landing({ from: 22, die: 3 })).toBe("off");
    expect(landing({ from: 24, die: 1 })).toBe("off");
    expect(landing({ from: 20, die: 6 })).toBe("off");
    expect(landing({ from: 20, die: 4 })).toBe(24);
    expect(destinations(state, 20)).toEqual([
      { pips: 5, to: "off", steps: [{ from: 20, die: 5 }] },
      { pips: 6, to: "off", steps: [{ from: 20, die: 6 }] },
    ]);
  });

  it("offers nothing from a point with no legal step", () => {
    expect(destinations(state, 5)).toEqual([]);
  });
});

describe("the combined moves", () => {
  // A 6-3 with the checker on 1 and another on 9. The server lists the lines of one checker.
  const state = startingState({
    ...moving(
      [6, 3],
      [
        { from: 1, die: 3 },
        { from: 1, die: 6 },
        { from: 9, die: 3 },
      ],
      [],
      [6, 3],
      [
        [{ from: 1, die: 3 }, { from: 4, die: 6 }],
        [{ from: 1, die: 6 }, { from: 7, die: 3 }],
        [{ from: 9, die: 3 }, { from: 12, die: 6 }],
      ],
    ),
  });

  it("add a way to the end of both dice, after the single ones", () => {
    const ways = destinations(state, 1);

    expect(ways.map((way) => [way.pips, way.to])).toEqual([
      [3, 4],
      [6, 7],
      [9, 10],
    ]);
    expect(ways[2]?.steps).toEqual([
      { from: 1, die: 3 },
      { from: 4, die: 6 },
    ]);
  });

  it("are offered only for the selected checker", () => {
    expect(destinations(state, 9).map((way) => [way.pips, way.to])).toEqual([
      [3, 12],
      [9, 18],
    ]);
  });

  it("are one way to a place that two orders of the dice both reach", () => {
    // 1 to 4 to 10, and 1 to 7 to 10: one marker, played the way the server lists first.
    const ways = destinations(state, 1).filter((way) => way.to === 10);

    expect(ways).toHaveLength(1);
    expect(ways[0]?.steps[0]).toEqual({ from: 1, die: 3 });
  });

  it("give a double a way for each length, marked by all the dice added up", () => {
    const double = startingState({
      ...moving(
        [5, 5],
        [{ from: 1, die: 5 }],
        [],
        [5, 5, 5, 5],
        [
          [{ from: 1, die: 5 }, { from: 6, die: 5 }],
          [{ from: 1, die: 5 }, { from: 6, die: 5 }, { from: 11, die: 5 }],
          [{ from: 1, die: 5 }, { from: 6, die: 5 }, { from: 11, die: 5 }, { from: 16, die: 5 }],
        ],
      ),
    });

    expect(destinations(double, 1).map((way) => [way.pips, way.to, way.steps.length])).toEqual([
      [5, 6, 1],
      [10, 11, 2],
      [15, 16, 3],
      [20, 21, 4],
    ]);
  });

  it("can end in a bear-off, next to a single die that bears off", () => {
    // On 21 with a 1 and a 4: the 4 bears off at once; the 1 and then the 4 does it too.
    const home = startingState({
      ...moving(
        [4, 1],
        [{ from: 21, die: 1 }, { from: 21, die: 4 }],
        [],
        [4, 1],
        [[{ from: 21, die: 1 }, { from: 22, die: 4 }]],
      ),
    });

    expect(destinations(home, 21).map((way) => [way.pips, way.to])).toEqual([
      [1, 22],
      [4, "off"],
      [5, "off"],
    ]);
  });

  it("are left out when the server lists none, as before the first roll or with one die left", () => {
    const one = startingState({ ...moving([6, 3], [{ from: 1, die: 3 }], [{ from: 9, die: 6 }], [3]) });

    expect(destinations(one, 1).map((way) => way.pips)).toEqual([3]);
  });
});

describe("diceWords", () => {
  it("names one die, or two different ones", () => {
    expect(diceWords([{ from: 1, die: 6 }])).toBe("the 6");
    expect(diceWords([{ from: 1, die: 6 }, { from: 7, die: 3 }])).toBe("the 6 and the 3");
  });

  it("counts the same die repeated", () => {
    expect(diceWords([{ from: 1, die: 5 }, { from: 6, die: 5 }])).toBe("two 5s");
    expect(diceWords([{ from: 1, die: 5 }, { from: 6, die: 5 }, { from: 11, die: 5 }])).toBe("three 5s");
    expect(
      diceWords([
        { from: 1, die: 5 },
        { from: 6, die: 5 },
        { from: 11, die: 5 },
        { from: 16, die: 5 },
      ]),
    ).toBe("four 5s");
  });
});

describe("hopVector", () => {
  const middle = { x: WIDTH / 2, y: HEIGHT / 2 };

  it("curves straight down on the top side, whatever the heights of the stacks", () => {
    expect(hopVector(slotCentre(1, 0), slotCentre(7, 0)).y).toBeGreaterThan(0); // towards the left
    expect(hopVector(slotCentre(7, 0), slotCentre(1, 0)).y).toBeGreaterThan(0); // and back
    // The ends are at different heights, which must not tilt the curve.
    expect(hopVector(slotCentre(1, 4, 5), slotCentre(7, 0, 1)).x).toBe(0);
    expect(hopVector(slotCentre(7, 0, 1), slotCentre(1, 4, 5)).x).toBe(0);
  });

  it("curves straight up on the bottom side, whatever the heights of the stacks", () => {
    expect(hopVector(slotCentre(13, 0), slotCentre(19, 0)).y).toBeLessThan(0); // towards the right
    expect(hopVector(slotCentre(19, 0), slotCentre(13, 0)).y).toBeLessThan(0); // and back
    expect(hopVector(slotCentre(13, 4, 5), slotCentre(19, 0, 1)).x).toBe(0);
    expect(hopVector(slotCentre(19, 0, 1), slotCentre(13, 4, 5)).x).toBe(0);
  });

  it("curves the same way whichever direction the trip goes, since an undo goes back", () => {
    const there = hopVector(slotCentre(1, 0), slotCentre(7, 0));
    const back = hopVector(slotCentre(7, 0), slotCentre(1, 0));

    expect(back).toEqual(there);
  });

  it("does not curve a trip from the top row to the bottom row, or back: it is a straight line", () => {
    expect(hopVector(slotCentre(12, 2), slotCentre(13, 2))).toEqual({ x: 0, y: 0 }); // the far left end
    expect(hopVector(slotCentre(13, 2), slotCentre(12, 2))).toEqual({ x: 0, y: 0 });
    // Not only at the end, and not only for neighbours.
    expect(hopVector(slotCentre(10, 0), slotCentre(15, 0))).toEqual({ x: 0, y: 0 });
    expect(hopVector(slotCentre(1, 0), slotCentre(24, 0))).toEqual({ x: 0, y: 0 });
  });

  it("curves a trip into the tray on the side the tray is on", () => {
    // The viewer's tray is the bottom one, reached from their home on the bottom row.
    const own = hopVector(slotCentre(20, 0), slabCentre(false, 0));
    expect(own.y).toBeLessThan(0);
    expect(own.x).toBe(0);
    // The opponent's is the top one, reached from their home on the top row.
    const theirs = hopVector(slotCentre(10, 0), slabCentre(true, 0));
    expect(theirs.y).toBeGreaterThan(0);
    expect(theirs.x).toBe(0);
  });

  it("is longer for a longer trip, within limits", () => {
    const short = hopVector(slotCentre(7, 0), slotCentre(6, 0));
    const long = hopVector(slotCentre(1, 0), slotCentre(7, 0));
    const very = hopVector({ x: 20, y: 60 }, { x: 700, y: 60 });

    expect(short.y).toBe(28);
    expect(long.y).toBeGreaterThan(short.y);
    expect(very.y).toBe(80);
  });

  it("does not push a trip that goes nowhere", () => {
    expect(hopVector(middle, middle)).toEqual({ x: 0, y: 0 });
    expect(hopVector(slotCentre(7, 0), slotCentre(7, 0))).toEqual({ x: 0, y: 0 });
  });
});

/** A way to play the checker on `from` with the given dice, as `destinations` builds it. */
function way(from: number, dice: number[], to: number | "off"): Destination {
  const steps = [];
  let at = from;
  for (const die of dice) {
    steps.push({ from: at, die });
    at += die;
  }
  return { pips: dice.reduce((a, b) => a + b, 0), to, steps };
}

describe("bearOffSteps", () => {
  it("bears off with the only die that can", () => {
    const ways = [way(20, [3], 23), way(20, [5], "off")];

    expect(bearOffSteps(20, ways)).toEqual([{ from: 20, die: 5 }]);
  });

  it("uses the larger die when two different dice can", () => {
    const ways = [way(20, [5], "off"), way(20, [6], "off")];

    expect(bearOffSteps(20, ways)).toEqual([{ from: 20, die: 6 }]);
    expect(bearOffSteps(20, [...ways].reverse())).toEqual([{ from: 20, die: 6 }]);
  });

  it("prefers a single die to several, which would spend more of the roll", () => {
    const ways = [way(21, [1], 22), way(21, [4], "off"), way(21, [1, 4], "off")];

    expect(bearOffSteps(21, ways)).toEqual([{ from: 21, die: 4 }]);
  });

  it("plays several dice when only they bear the checker off", () => {
    // On 19 with two 3s: the first lands on 22, and the second bears off from there.
    const ways = [way(19, [3], 22), way(19, [3, 3], "off")];

    expect(bearOffSteps(19, ways)).toEqual([
      { from: 19, die: 3 },
      { from: 22, die: 3 },
    ]);
  });

  it("is nothing when no die bears the checker off, or nothing is selected", () => {
    expect(bearOffSteps(20, [way(20, [3], 23)])).toBeNull();
    expect(bearOffSteps(20, [])).toBeNull();
    expect(bearOffSteps(null, [way(20, [5], "off")])).toBeNull();
  });
});

describe("pressOutcome", () => {
  // The checker on 1 may play a 3 (to 4), a 6 (to 7), or both (to 10); another checker on 4 may also move.
  const ways = [way(1, [3], 4), way(1, [6], 7), way(1, [3, 6], 10)];
  const sources = new Set([1, 4]);

  it("moves the selected checker when the background of a landing place is pressed", () => {
    expect(pressOutcome("background", 7, 1, ways, sources)).toEqual({
      type: "move",
      steps: [{ from: 1, die: 6 }],
    });
  });

  it("plays all the steps of a combined move from the one press", () => {
    expect(pressOutcome("background", 10, 1, ways, sources)).toEqual({
      type: "move",
      steps: [
        { from: 1, die: 3 },
        { from: 4, die: 6 },
      ],
    });
  });

  it("selects the pieces on a landing place instead of moving there", () => {
    // Point 4 is a landing place for the 3 and also has a checker that can move.
    expect(pressOutcome("piece", 4, 1, ways, sources)).toEqual({ type: "select", point: 4 });
    // The background of the very same point is what moves.
    expect(pressOutcome("background", 4, 1, ways, sources)).toEqual({
      type: "move",
      steps: [{ from: 1, die: 3 }],
    });
  });

  it("selects when the background of a point that is no landing place has movable checkers", () => {
    expect(pressOutcome("background", 1, null, [], sources)).toEqual({ type: "select", point: 1 });
    expect(pressOutcome("background", 4, 1, [way(1, [6], 7)], sources)).toEqual({
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
    const over = startingState({ lastTurn, phase: { type: "over", winner: 0, points: 1, forfeited: false } });
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
