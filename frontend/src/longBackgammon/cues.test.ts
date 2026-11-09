import { describe, expect, it } from "vitest";
import { board, startingState } from "../fixtures";
import { type Change, MOVE_MS, ROLL_MS, cuesFor } from "./cues";
import type { Motion } from "./motion";

const base: Change = { motion: null, ended: false, state: startingState(), viewer: 0, player: true };
const step = (to: number | "off"): Motion => ({
  type: "move",
  seat: 0,
  from: { at: 1, count: 14 },
  to: { at: to, count: 1 },
});
const over = (winner: 0 | 1 | null) =>
  startingState({ points: [board({}), board({ 1: 15 })], phase: { type: "over", winner, points: 1, forfeited: false } });

describe("the sounds for a change", () => {
  it("rattles the dice at the moment they are thrown", () => {
    expect(cuesFor({ ...base, motion: { type: "roll" } })).toEqual([{ cue: "roll", afterMs: 0 }]);
  });

  it("knocks a checker where it lands, when it lands", () => {
    expect(cuesFor({ ...base, motion: step(7) })).toEqual([{ cue: "move", afterMs: MOVE_MS }]);
  });

  it("lays a borne-off checker down with its own sound", () => {
    expect(cuesFor({ ...base, motion: step("off") })).toEqual([{ cue: "bearOff", afterMs: MOVE_MS }]);
  });

  it("is silent when the change cannot be followed with the eye", () => {
    expect(cuesFor(base)).toEqual([]);
  });

  describe("at the end of the game", () => {
    const lastMove = step("off");

    it("plays a win after the last checker has landed", () => {
      const cues = cuesFor({ ...base, motion: lastMove, ended: true, state: over(0) });

      expect(cues.map((c) => c.cue)).toEqual(["bearOff", "win"]);
      expect(cues[1]?.afterMs).toBeGreaterThan(MOVE_MS);
    });

    it("plays a loss for the player who lost", () => {
      const cues = cuesFor({ ...base, motion: lastMove, ended: true, state: over(1) });

      expect(cues.map((c) => c.cue)).toEqual(["bearOff", "lose"]);
    });

    it("plays a neutral end for a spectator, whoever won, and for a draw", () => {
      const watching = { ...base, motion: lastMove, ended: true, player: false };

      expect(cuesFor({ ...watching, state: over(0) }).map((c) => c.cue)).toEqual(["bearOff", "end"]);
      expect(cuesFor({ ...watching, state: over(1) }).map((c) => c.cue)).toEqual(["bearOff", "end"]);
      expect(cuesFor({ ...base, ended: true, state: over(null) }).map((c) => c.cue)).toEqual(["end"]);
    });

    it("waits for the dice when the last throw has nothing to play", () => {
      const cues = cuesFor({ ...base, motion: { type: "roll" }, ended: true, state: over(0) });

      expect(cues.map((c) => c.cue)).toEqual(["roll", "win"]);
      expect(cues[1]?.afterMs).toBeGreaterThan(ROLL_MS);
    });

    it("is quiet for a game that was already over when the board opened", () => {
      expect(cuesFor({ ...base, ended: false, state: over(0) })).toEqual([]);
    });
  });
});
