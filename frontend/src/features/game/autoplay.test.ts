import { describe, expect, it } from "vitest";
import { moving, snapshotOf, startingState } from "../../fixtures";
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
    const over = startingState({ phase: { type: "over", winner: 0, points: 1 } });
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
