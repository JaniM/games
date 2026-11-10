import { describe, expect, it } from "vitest";
import { hexState, stones } from "../fixtures";
import { advance, cuesFor, placedBetween } from "./cues";

const fresh = hexState();
const opened = hexState({ cells: stones({ f6: 0 }), turn: 1, last: { seat: 0, column: 5, row: 5, swap: false } });
const swapped = hexState({ cells: stones({ e4: 1 }), swapped: true, last: { seat: 1, column: 4, row: 3, swap: true } });
const later = hexState({
  cells: stones({ f6: 0, a1: 1, b2: 0 }),
  turn: 1,
  last: { seat: 0, column: 1, row: 1, swap: false },
});

describe("placedBetween", () => {
  it("is the stone one position has more than the one before", () => {
    expect(placedBetween(fresh, opened)).toEqual(opened.last);
  });

  it("is the swap's stone, though the number of stones stays the same", () => {
    const red = hexState({ cells: stones({ d5: 0 }), turn: 1, last: { seat: 0, column: 3, row: 4, swap: false } });

    expect(placedBetween(red, swapped)).toEqual(swapped.last);
  });

  it("is nothing for the first position, the start, or several moves at once", () => {
    expect(placedBetween(null, opened)).toBeNull();
    expect(placedBetween(opened, fresh)).toBeNull();
    expect(placedBetween(fresh, later)).toBeNull();
  });

  it("is nothing when stepping back, or for the same position again", () => {
    expect(placedBetween(later, opened)).toBeNull();
    expect(placedBetween(opened, opened)).toBeNull();
  });
});

describe("cuesFor", () => {
  const over = hexState({ ...opened, phase: { type: "over", winner: 0, forfeited: false } });

  it("clicks for a stone, and is silent for a position that was not followed", () => {
    expect(cuesFor({ placed: opened.last, ended: false, state: opened, viewer: 0, player: true })).toEqual([
      { cue: "move", afterMs: 0 },
    ]);
    expect(cuesFor({ placed: null, ended: false, state: opened, viewer: 0, player: true })).toEqual([]);
  });

  it("ends the game with a jingle that says whether the viewer won, after the stone", () => {
    const won = cuesFor({ placed: over.last, ended: true, state: over, viewer: 0, player: true });
    const lost = cuesFor({ placed: over.last, ended: true, state: over, viewer: 1, player: true });
    const watched = cuesFor({ placed: null, ended: true, state: over, viewer: 0, player: false });

    expect(won).toEqual([
      { cue: "move", afterMs: 0 },
      { cue: "win", afterMs: 250 },
    ]);
    expect(lost.at(-1)?.cue).toBe("lose");
    expect(watched).toEqual([{ cue: "end", afterMs: 250 }]);
  });
});

describe("advance", () => {
  it("keeps the same object for the same revision, and sees a move and an end in a new one", () => {
    const held = { revision: 1, state: fresh, placed: null, ended: false };
    expect(advance(held, opened, 1)).toBe(held);

    const next = advance(held, opened, 2);
    expect(next).toMatchObject({ revision: 2, placed: opened.last, ended: false });

    const over = hexState({ ...opened, phase: { type: "over", winner: 1, forfeited: true } });
    expect(advance(next, over, 3).ended).toBe(true);
    expect(advance({ revision: 1, state: null, placed: null, ended: false }, over, 2).ended).toBe(false);
  });
});
