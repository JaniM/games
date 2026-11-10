import { describe, expect, it } from "vitest";
import { HEIGHT, MIDDLE, RADIUS, WIDTH, centre, corners, hexagon } from "./geometry";

describe("the board's geometry", () => {
  it("is a rhombus √3 times as wide as it is tall, with every cell inside it", () => {
    expect(WIDTH / HEIGHT).toBeCloseTo(Math.sqrt(3), 9);
    for (let row = 0; row < 11; row++) {
      for (let column = 0; column < 11; column++) {
        const { x, y } = centre(column, row);
        expect(x - (RADIUS * Math.sqrt(3)) / 2).toBeGreaterThan(0);
        expect(x + (RADIUS * Math.sqrt(3)) / 2).toBeLessThan(WIDTH);
        expect(y - RADIUS).toBeGreaterThan(0);
        expect(y + RADIUS).toBeLessThan(HEIGHT);
      }
    }
  });

  it("puts a1 at the top left, and each row half a cell to the right of the one above", () => {
    const a1 = centre(0, 0);
    const k1 = centre(10, 0);
    const a2 = centre(0, 1);
    const b1 = centre(1, 0);

    expect(k1.y).toBe(a1.y);
    expect(k1.x).toBeGreaterThan(a1.x);
    expect(a2.x - a1.x).toBeCloseTo((b1.x - a1.x) / 2, 9);
    expect(a2.y).toBeGreaterThan(a1.y);
  });

  it("makes neighbours one cell's width apart, and the cells that are not neighbours further", () => {
    const width = RADIUS * Math.sqrt(3);
    const distance = (a: [number, number], b: [number, number]) => {
      const p = centre(...a);
      const q = centre(...b);
      return Math.hypot(p.x - q.x, p.y - q.y);
    };
    // f6's six neighbours, as the rules list them.
    for (const neighbour of [[5, 4], [6, 4], [4, 5], [6, 5], [4, 6], [5, 6]] as [number, number][]) {
      expect(distance([5, 5], neighbour)).toBeCloseTo(width, 9);
    }
    // e5 and g7 are not.
    expect(distance([5, 5], [4, 4])).toBeGreaterThan(width * 1.5);
    expect(distance([5, 5], [6, 6])).toBeGreaterThan(width * 1.5);
  });

  it("has a hexagon of six corners for a cell, and a rhombus whose sides are as far from the cells as each other", () => {
    expect(hexagon(5, 5).split(" ")).toHaveLength(6);
    const [a1, k1, k11, a11] = corners();
    expect(a1).toEqual({ x: 0, y: 0 });
    expect(k11.x).toBeCloseTo(WIDTH, 9);
    expect(k1.x - a1.x).toBeCloseTo(k11.x - a11.x, 9);
    expect(MIDDLE).toEqual({ x: WIDTH / 2, y: HEIGHT / 2 });
  });
});
