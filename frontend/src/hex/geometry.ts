import { HEX_SIZE } from "../features/game/hex";

// Where things are on the Hex board, in the units of its SVG. The board is drawn as in the rules
// (`docs/games/hex.md`): `a1` at the top left, row 1 along the top, column `a` down the left, each
// row half a cell to the right of the one above, and each player's edges in their colour. The
// server draws the same board for the preview of a link (`backend/src/hex/picture.rs`): keep the
// two in step.

/** A cell's corners are this far from its centre. The cells have a point at the top. */
export const RADIUS = 20;

/** How far the coloured edges reach out beyond the cells. */
export const BORDER = 10;

/** What a stone's radius is of a cell's. */
export const STONE = 0.74;

/** What the radius of the dot on the last stone is of a cell's. */
export const DOT = 0.22;

const SQRT_3 = Math.sqrt(3);

/** A cell's width, from one flat side to the other. */
const CELL_WIDTH = RADIUS * SQRT_3;

/** How far the rhombus the edges are drawn on reaches beyond the centres of the outer cells. */
const REACH = RADIUS + BORDER;

/** How far the centre of `a1` is from the left and the top of the drawing. */
const LEFT = SQRT_3 * REACH;
const TOP = REACH;

/** The span from the first row or column to the last. */
const SPAN = HEX_SIZE - 1;

/**
 * The drawing's width and height. The rows are 1.5 radii apart, and the last is half a cell to the
 * right of the one above it for every row, so a 60° rhombus is √3 times as wide as it is tall.
 */
export const WIDTH = CELL_WIDTH * SPAN * 1.5 + 2 * LEFT;
export const HEIGHT = RADIUS * SPAN * 1.5 + 2 * TOP;

export interface Point {
  x: number;
  y: number;
}

/** The centre of the cell in `column` and `row`, both counted from 0. */
export function centre(column: number, row: number): Point {
  return { x: LEFT + CELL_WIDTH * (column + row / 2), y: TOP + 1.5 * RADIUS * row };
}

/** The six corners of a cell, as the `points` of an SVG polygon. */
export function hexagon(column: number, row: number): string {
  const { x, y } = centre(column, row);
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    return `${(x + RADIUS * Math.cos(angle)).toFixed(2)},${(y + RADIUS * Math.sin(angle)).toFixed(2)}`;
  }).join(" ");
}

/**
 * The corners of the rhombus the edges are drawn on, by `a1`, `k1`, `k11` and `a11`. The acute
 * ones (`a1` and `k11`) reach further out, along the long diagonal.
 */
export function corners(): [Point, Point, Point, Point] {
  const span = CELL_WIDTH * SPAN;
  // Out from the obtuse corners' cells, along the short diagonal.
  const side = REACH / SQRT_3;
  return [
    { x: 0, y: 0 },
    { x: LEFT + span + side, y: 0 },
    { x: WIDTH, y: HEIGHT },
    { x: LEFT + span / 2 - side, y: HEIGHT },
  ];
}

/** The rhombus's middle, where its four edges meet when it is cut along its diagonals. */
export const MIDDLE: Point = { x: WIDTH / 2, y: HEIGHT / 2 };

/** Points as the `points` of an SVG polygon. */
export function pointsOf(points: readonly Point[]): string {
  return points.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}
