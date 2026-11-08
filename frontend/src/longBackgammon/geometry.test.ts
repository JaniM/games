import { describe, expect, it } from "vitest";
import {
  BETWEEN_TRAYS,
  BOTTOM,
  DIE_SIZE,
  MAX_STACK,
  POINT_HEIGHT,
  POINT_WIDTH,
  RADIUS,
  STACK_STEP,
  TOP,
  TRAY_WIDTH,
  TRAY_X,
  betweenTraysSpot,
  columnX,
  diceSpots,
  slotCentre,
  slotY,
  stackStep,
  trayY,
} from "./geometry";

describe("the gap between the trays", () => {
  it("is in the trays' column, between the top tray and the bottom one", () => {
    expect(BETWEEN_TRAYS.x).toBe(TRAY_X + TRAY_WIDTH / 2);
    expect(BETWEEN_TRAYS.y).toBeGreaterThan(trayY(true) + POINT_HEIGHT);
    expect(BETWEEN_TRAYS.y).toBeLessThan(trayY(false));
  });

  it("is to the right of every point, so that no stack can be under a button there", () => {
    const rightmost = columnX(11) + POINT_WIDTH;
    expect(TRAY_X).toBeGreaterThanOrEqual(rightmost);
  });

  it("is to the right of the dice, even four of them", () => {
    const last = diceSpots(4).at(-1);
    expect(last).toBeDefined();
    expect(BETWEEN_TRAYS.x).toBeGreaterThan((last?.x ?? 0) + DIE_SIZE);
  });

  it("is given as percentages of the board", () => {
    expect(betweenTraysSpot()).toEqual({ left: "92.78%", top: "50.00%" });
  });
});

describe("stackStep", () => {
  it("is the full step up to a full stack", () => {
    for (let count = 1; count <= MAX_STACK; count++) expect(stackStep(count)).toBe(STACK_STEP);
  });

  it("squeezes the checkers of a longer stack, the more the longer", () => {
    expect(stackStep(MAX_STACK + 1)).toBeLessThan(STACK_STEP);
    for (let count = MAX_STACK + 1; count < 16; count++) {
      expect(stackStep(count + 1)).toBeLessThan(stackStep(count));
    }
  });

  it("never squeezes them into one place", () => {
    expect(stackStep(16)).toBeGreaterThan(5);
  });
});

describe("a stack of checkers", () => {
  const counts = Array.from({ length: 16 }, (_, i) => i + 1);

  it("starts at the base of its point, on either side of the board", () => {
    expect(slotY("top", 0, 15)).toBe(TOP + RADIUS + 2);
    expect(slotY("bottom", 0, 15)).toBe(BOTTOM - RADIUS - 2);
  });

  it("is never taller than a full stack of five, so a long one fits as well", () => {
    for (const count of counts.filter((n) => n >= MAX_STACK)) {
      expect(slotY("top", count - 1, count)).toBe(slotY("top", MAX_STACK - 1));
      expect(slotY("bottom", count - 1, count)).toBe(slotY("bottom", MAX_STACK - 1));
    }
  });

  it("has every checker in a place of its own, in order, so that all of them show", () => {
    for (const count of counts) {
      const ys = Array.from({ length: count }, (_, slot) => slotY("top", slot, count));
      expect(new Set(ys).size).toBe(count);
      expect([...ys].sort((a, b) => a - b)).toEqual(ys);
      // The top one of the stack stays inside the point, give or take the radius it hangs over.
      expect(Math.max(...ys) + RADIUS).toBeLessThanOrEqual(TOP + POINT_HEIGHT + 8);
    }
  });

  it("mirrors on the bottom row", () => {
    for (const count of [3, 8, 15]) {
      for (let slot = 0; slot < count; slot++) {
        const top = slotY("top", slot, count) - TOP;
        const bottom = BOTTOM - slotY("bottom", slot, count);
        expect(bottom).toBeCloseTo(top, 5);
      }
    }
  });

  it("puts a point's checkers in its column", () => {
    expect(slotCentre(1, 0, 15).x).toBe(slotCentre(1, 14, 15).x);
    expect(slotCentre(1, 0, 15).x).not.toBe(slotCentre(2, 0, 15).x);
  });

  it("places the top checker of a point where a flight to or from it should end", () => {
    expect(slotCentre(7, 14, 15)).toEqual(slotCentre(7, 4));
  });
});
