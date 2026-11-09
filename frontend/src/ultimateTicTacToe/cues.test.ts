import { describe, expect, it } from "vitest";
import { marks, utttState } from "../fixtures";
import { advance, cuesFor, placedBetween } from "./cues";

const start = utttState();
/** Seat 0 marked cell 4 of board 4. */
const first = utttState({ turn: 1, last: { seat: 0, board: 4, cell: 4 }, cells: marks({ 4: { 4: 0 } }) });
/** Seat 1 answered in cell 0 of board 4. */
const second = utttState({
  turn: 0,
  last: { seat: 1, board: 4, cell: 0 },
  cells: marks({ 4: { 4: 0, 0: 1 } }),
});
const over = utttState({
  ...second,
  phase: { type: "over", winner: 1, forfeited: false },
});

describe("placedBetween", () => {
  it("is the mark that one position has more than the one before", () => {
    expect(placedBetween(start, first)).toEqual({ seat: 0, board: 4, cell: 4 });
    expect(placedBetween(first, second)).toEqual({ seat: 1, board: 4, cell: 0 });
  });

  it("is nothing for the first position, which was not seen to come about", () => {
    expect(placedBetween(null, first)).toBeNull();
    expect(placedBetween(first, null)).toBeNull();
    expect(placedBetween(null, null)).toBeNull();
  });

  it("is nothing for a position with no mark, like the start", () => {
    expect(placedBetween(first, start)).toBeNull();
  });

  it("is nothing when several marks came at once, as after a reconnect that missed some", () => {
    expect(placedBetween(start, second)).toBeNull();
  });

  it("is nothing when stepping back, where one mark less is no mark placed", () => {
    expect(placedBetween(second, first)).toBeNull();
  });

  it("is nothing for the same position, or one where only the label changed", () => {
    expect(placedBetween(first, first)).toBeNull();
  });

  it("is nothing for a forfeit, which places no mark", () => {
    const forfeited = utttState({ ...first, phase: { type: "over", winner: 1, forfeited: true } });

    expect(placedBetween(first, forfeited)).toBeNull();
  });
});

describe("cuesFor", () => {
  const seen = { state: second, viewer: 0 as const, player: true };

  it("clicks for a mark, at once", () => {
    expect(cuesFor({ ...seen, placed: { seat: 1, board: 4, cell: 0 }, ended: false })).toEqual([
      { cue: "move", afterMs: 0 },
    ]);
  });

  it("is silent for a position that was not followed", () => {
    expect(cuesFor({ ...seen, placed: null, ended: false })).toEqual([]);
  });

  it("ends the game with a jingle that says whether the viewer won", () => {
    const placed = { seat: 1 as const, board: 4, cell: 0 };

    expect(cuesFor({ state: over, viewer: 1, player: true, placed, ended: true }).map((c) => c.cue)).toEqual([
      "move",
      "win",
    ]);
    expect(cuesFor({ state: over, viewer: 0, player: true, placed, ended: true }).map((c) => c.cue)).toEqual([
      "move",
      "lose",
    ]);
  });

  it("gives a spectator the neutral end, and a draw the same", () => {
    const draw = utttState({ ...second, phase: { type: "over", winner: null, forfeited: false } });

    expect(cuesFor({ state: over, viewer: 0, player: false, placed: null, ended: true })).toEqual([
      { cue: "end", afterMs: 250 },
    ]);
    expect(cuesFor({ state: draw, viewer: 0, player: true, placed: null, ended: true }).map((c) => c.cue)).toEqual([
      "end",
    ]);
  });

  it("waits for the mark before the jingle", () => {
    const [mark, jingle] = cuesFor({
      state: over,
      viewer: 1,
      player: true,
      placed: { seat: 1, board: 4, cell: 0 },
      ended: true,
    });

    expect(jingle?.afterMs).toBeGreaterThan(mark?.afterMs ?? 0);
  });
});

describe("advance", () => {
  const held = { revision: 1, state: start, placed: null, ended: false };

  it("keeps the same object for the same revision", () => {
    expect(advance(held, start, 1)).toBe(held);
  });

  it("holds the mark that led to a new revision", () => {
    expect(advance(held, first, 2)).toEqual({
      revision: 2,
      state: first,
      placed: { seat: 0, board: 4, cell: 4 },
      ended: false,
    });
  });

  it("sees a game end only when it was on before", () => {
    const playing = { revision: 2, state: second, placed: null, ended: false };

    expect(advance(playing, over, 3).ended).toBe(true);
    expect(advance({ ...playing, state: over }, over, 3).ended).toBe(false);
    expect(advance({ revision: 0, state: null, placed: null, ended: false }, over, 1).ended).toBe(false);
  });
});
