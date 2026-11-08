import { describe, expect, it } from "vitest";
import { board, moving, startingState } from "../fixtures";
import { motionBetween } from "./motion";
import { advance } from "./useMotion";

// Seat 0 is White and to move, both heads full, unless a test says otherwise.
const rolled = startingState(moving([6, 3], [{ from: 1, die: 6 }, { from: 1, die: 3 }]));

/** `rolled` after the mover played the 6 with a checker from the head. */
const afterSix = startingState({
  points: [board({ 1: 14, 7: 1 }), board({ 1: 15 })],
  ...moving([6, 3], [{ from: 7, die: 3 }], [{ from: 1, die: 6 }], [3]),
});

describe("a roll", () => {
  it("is what leads from the player to roll to a position with dice to play", () => {
    expect(motionBetween(startingState(), rolled, 0)).toEqual({ type: "roll" });
    expect(motionBetween(startingState(), rolled, 1)).toEqual({ type: "roll" });
  });

  it("is also a roll that leaves nothing to play, which ends the turn at once", () => {
    const lost = startingState({
      turn: 1,
      turns: [1, 0],
      lastTurn: { seat: 0, dice: [6, 5], played: [] },
    });

    expect(motionBetween(startingState(), lost, 0)).toEqual({ type: "roll" });
  });

  it("is not a turn that was played to its end", () => {
    const played = startingState({
      turn: 1,
      turns: [1, 0],
      lastTurn: { seat: 0, dice: [6, 5], played: [{ from: 1, die: 6 }, { from: 7, die: 5 }] },
    });

    expect(motionBetween(startingState(), played, 0)).toBeNull();
  });
});

describe("a step", () => {
  it("is a checker leaving one point for another, counted as the viewer counts", () => {
    expect(motionBetween(rolled, afterSix, 0)).toEqual({
      type: "move",
      seat: 0,
      from: { at: 1, count: 15 },
      to: { at: 7, count: 1 },
    });
  });

  it("is the same step for the other player, on their side of the numbering", () => {
    // Seat 0's points 1 and 7 are 13 and 19 to seat 1.
    expect(motionBetween(rolled, afterSix, 1)).toEqual({
      type: "move",
      seat: 0,
      from: { at: 13, count: 15 },
      to: { at: 19, count: 1 },
    });
  });

  it("counts the checkers already on the point it joins", () => {
    const before = startingState({
      points: [board({ 1: 13, 7: 2 }), board({ 1: 15 })],
      ...moving([6, 3], [{ from: 1, die: 6 }]),
    });
    const after = startingState({
      points: [board({ 1: 12, 7: 3 }), board({ 1: 15 })],
      ...moving([6, 3], [], [{ from: 1, die: 6 }], [3]),
    });

    expect(motionBetween(before, after, 0)).toMatchObject({
      from: { at: 1, count: 13 },
      to: { at: 7, count: 3 },
    });
  });

  it("is still followed when it ends the turn and passes it on", () => {
    const end = startingState({
      turn: 1,
      turns: [1, 0],
      points: [board({ 1: 14, 10: 1 }), board({ 1: 15 })],
      lastTurn: { seat: 0, dice: [6, 3], played: [{ from: 1, die: 6 }, { from: 7, die: 3 }] },
    });

    expect(motionBetween(afterSix, end, 0)).toMatchObject({
      seat: 0,
      from: { at: 7, count: 1 },
      to: { at: 10, count: 1 },
    });
  });

  it("is a checker going to the tray when it bears off", () => {
    const before = startingState({
      points: [board({ 20: 1, 22: 14 }), board({ 1: 15 })],
      ...moving([5, 6], [{ from: 20, die: 5 }]),
    });
    const after = startingState({
      points: [board({ 22: 14 }), board({ 1: 15 })],
      off: [1, 0],
      ...moving([5, 6], [{ from: 22, die: 6 }], [{ from: 20, die: 5 }], [6]),
    });

    expect(motionBetween(before, after, 0)).toEqual({
      type: "move",
      seat: 0,
      from: { at: 20, count: 1 },
      to: { at: "off", count: 1 },
    });
  });

  it("is followed to the tray when the last checker ends the game", () => {
    const before = startingState({
      points: [board({ 24: 1 }), board({ 1: 15 })],
      off: [14, 0],
      ...moving([1, 2], [{ from: 24, die: 1 }]),
    });
    const after = startingState({
      points: [board({}), board({ 1: 15 })],
      off: [15, 0],
      phase: { type: "over", winner: 0, points: 2 },
    });

    expect(motionBetween(before, after, 0)).toMatchObject({
      to: { at: "off", count: 15 },
    });
  });

  it("is the way back when a step is undone", () => {
    expect(motionBetween(afterSix, rolled, 0)).toEqual({
      type: "move",
      seat: 0,
      from: { at: 7, count: 1 },
      to: { at: 1, count: 15 },
    });
  });

  it("brings a checker back from the tray when a bear-off is undone", () => {
    const home = startingState({
      points: [board({ 20: 1, 22: 14 }), board({ 1: 15 })],
      ...moving([5, 6], [{ from: 20, die: 5 }]),
    });
    const borne = startingState({
      points: [board({ 22: 14 }), board({ 1: 15 })],
      off: [1, 0],
      ...moving([5, 6], [{ from: 22, die: 6 }], [{ from: 20, die: 5 }], [6]),
    });

    expect(motionBetween(borne, home, 0)).toEqual({
      type: "move",
      seat: 0,
      from: { at: "off", count: 1 },
      to: { at: 20, count: 1 },
    });
  });
});

describe("nothing to follow", () => {
  it("is the case without an earlier position, or without a later one", () => {
    expect(motionBetween(null, rolled, 0)).toBeNull();
    expect(motionBetween(rolled, null, 0)).toBeNull();
    expect(motionBetween(null, null, 0)).toBeNull();
  });

  it("is a position that did not change", () => {
    expect(motionBetween(rolled, rolled, 0)).toBeNull();
  });

  it("is several steps at once, as after a missed update", () => {
    const later = startingState({
      points: [board({ 1: 13, 7: 1, 4: 1 }), board({ 1: 15 })],
      ...moving([6, 3], [], [{ from: 1, die: 6 }, { from: 1, die: 3 }], []),
    });

    expect(motionBetween(rolled, later, 0)).toBeNull();
  });

  it("is a change of the other player's checkers", () => {
    const odd = startingState({
      points: [board({ 1: 14, 7: 1 }), board({ 1: 14, 2: 1 })],
      ...moving([6, 3], [], [{ from: 1, die: 6 }], [3]),
    });

    expect(motionBetween(rolled, odd, 0)).toBeNull();
  });
});

describe("what the board holds on to", () => {
  const first = advance(
    { revision: 1, state: startingState(), motion: null, rolls: 0, ended: false },
    startingState(),
    1,
    0,
  );

  it("starts with nothing happening and no rolls, wherever the game stands", () => {
    expect(first).toMatchObject({ motion: null, rolls: 0 });
  });

  it("keeps the same record for the same revision, even with a new copy of the state", () => {
    const again = advance(first, startingState(), 1, 0);

    expect(again).toBe(first);
  });

  it("counts each roll, and replaces the event with every new revision", () => {
    const afterRoll = advance(first, rolled, 2, 0);
    expect(afterRoll).toMatchObject({ revision: 2, motion: { type: "roll" }, rolls: 1 });

    const afterStep = advance(afterRoll, afterSix, 3, 0);
    expect(afterStep).toMatchObject({ revision: 3, motion: { type: "move" }, rolls: 1 });

    // A position that is not a step from the last one: no event, and the rolls stay counted.
    const missed = startingState({
      points: [board({ 1: 12, 4: 1, 7: 1, 10: 1 }), board({ 1: 15 })],
      ...moving([6, 3], [{ from: 7, die: 3 }], [], [3]),
    });
    const jumped = advance(afterStep, missed, 9, 0);
    expect(jumped).toMatchObject({ revision: 9, motion: null, rolls: 1 });
  });
});

describe("seeing a game end", () => {
  const nearlyOver = startingState({
    points: [board({ 24: 1 }), board({ 1: 15 })],
    off: [14, 0],
    ...moving([1, 2], [{ from: 24, die: 1 }]),
  });
  const over = startingState({
    points: [board({}), board({ 1: 15 })],
    off: [15, 0],
    phase: { type: "over", winner: 0, points: 1 },
  });
  const held = (state: typeof nearlyOver, revision: number) => ({
    revision,
    state,
    motion: null,
    rolls: 0,
    ended: false,
  });

  it("marks the position in which it ended, and only that one", () => {
    const ended = advance(held(nearlyOver, 5), over, 6, 0);
    expect(ended.ended).toBe(true);

    // Labels changing at the same revision leave it as it was; the next position does not repeat it.
    expect(advance(ended, over, 6, 0)).toBe(ended);
    expect(advance(ended, over, 7, 0).ended).toBe(false);
  });

  it("does not mark a game that was already over when the board opened", () => {
    expect(advance(held(over, 6), over, 7, 0).ended).toBe(false);
  });

  it("marks an end reached over several missed moves", () => {
    expect(advance(held(startingState(), 2), over, 9, 0)).toMatchObject({ motion: null, ended: true });
  });
});
