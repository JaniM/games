import { pointSlot } from "./layout";

// Where things are on the board, in the board's own units (the SVG scales them to the page).
// The viewer's head is top right and their home bottom right, whoever the viewer is.

export const WIDTH = 720;
export const HEIGHT = 520;
export const MARGIN = 12;
export const POINT_WIDTH = 48;
export const BAR_WIDTH = 28;
export const TOP = 28; // where the bases of the top row sit
export const BOTTOM = HEIGHT - 28;
export const POINT_HEIGHT = 170;
export const RADIUS = 19;
export const STACK_STEP = 34;
/**
 * A point with more checkers than this squeezes them closer so that they all fit, instead of
 * growing taller (see `stackStep`).
 */
export const MAX_STACK = 5;
export const TRAY_X = 628;
export const TRAY_WIDTH = 80;
export const SLAB_HEIGHT = 10;
export const SLAB_STEP = 11;

export interface Xy {
  x: number;
  y: number;
}

export const columnX = (column: number) =>
  MARGIN + column * POINT_WIDTH + (column >= 6 ? BAR_WIDTH : 0);

/**
 * The gap between neighbouring checkers on a point with `count` of them. Up to `MAX_STACK`
 * they sit a full `STACK_STEP` apart. More are squeezed so that the stack is as tall as a
 * full one and no taller: the top checker stays where the fifth would be, and the ones below
 * overlap, each showing its edge.
 */
export function stackStep(count: number): number {
  return count <= MAX_STACK ? STACK_STEP : ((MAX_STACK - 1) * STACK_STEP) / (count - 1);
}

/**
 * The y of the centre of the checker in `slot` (0 is at the base) of a point in `row` that
 * holds `count` checkers. The count sets the spacing, so a checker's place moves a little
 * when the stack changes size. Without a count the stack is taken to be a full-size one.
 */
export function slotY(row: "top" | "bottom", slot: number, count = MAX_STACK): number {
  const top = row === "top";
  const y = (top ? TOP : BOTTOM) + (top ? 1 : -1) * (RADIUS + 2 + slot * stackStep(count));
  return Math.round(y * 100) / 100; // 157 and not 156.99999999999997
}

/** The centre of the checker in `slot` of the viewer's point `k`, which holds `count` checkers. */
export function slotCentre(k: number, slot: number, count = MAX_STACK): Xy {
  const { row, column } = pointSlot(k);
  return { x: columnX(column) + POINT_WIDTH / 2, y: slotY(row, slot, count) };
}

/** The top edge of a tray. The opponent's is the top right one, the viewer's the bottom right. */
export const trayY = (top: boolean) => (top ? TOP : BOTTOM - POINT_HEIGHT);

/** The top edge of the borne-off checker in slot `i`, which are stacked from the tray's far end. */
export function slabY(top: boolean, i: number): number {
  const y = trayY(top);
  return top ? y + 4 + i * SLAB_STEP : y + POINT_HEIGHT - 4 - SLAB_HEIGHT - i * SLAB_STEP;
}

/** The centre of the borne-off checker in slot `i` of a tray. */
export function slabCentre(top: boolean, i: number): Xy {
  return { x: TRAY_X + TRAY_WIDTH / 2, y: slabY(top, i) + SLAB_HEIGHT / 2 };
}

// --- The hop of a moving checker ---

const MIN_HOP = 28;
const MAX_HOP = 80;
const HOP_PER_DISTANCE = 0.22;

/** Which half of the board a place is in. The points, and the trays with their slabs, keep to one. */
const sideOf = (at: Xy): "top" | "bottom" => (at.y < HEIGHT / 2 ? "top" : "bottom");

/**
 * How far a checker that moves from `from` to `to` is pushed off the straight line at the
 * top of its hop, as a vector. It depends on the sides of the board the trip starts and ends on:
 *
 * - On the top side both ways, it curves straight down, towards the middle of the board.
 * - On the bottom side both ways, it curves straight up.
 * - From one side to the other, it does not curve: the vector is zero and the trip is a straight line.
 *
 * The push is as long as more for a longer trip (within limits), and the same whichever way
 * the trip goes, since an undone step goes back.
 */
export function hopVector(from: Xy, to: Xy): Xy {
  const side = sideOf(from);
  if (side !== sideOf(to)) return { x: 0, y: 0 };

  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance === 0) return { x: 0, y: 0 };

  const height = Math.round(Math.min(MAX_HOP, Math.max(MIN_HOP, distance * HOP_PER_DISTANCE)));
  return { x: 0, y: side === "top" ? height : -height };
}

// --- The dice ---

export const DIE_SIZE = 44;
const DIE_GAP = 14;
/**
 * Where the dice are thrown: the middle strip between the two rows of points, in the right
 * half of the board, towards the top of the strip so that a button fits under them.
 */
const DICE_CENTRE: Xy = {
  x: columnX(6) + (6 * POINT_WIDTH) / 2,
  y: TOP + POINT_HEIGHT + 38,
};
/** The gap between the dice and the button under them. */
const ROLL_GAP = 12;

/**
 * Where the Roll button goes, as CSS percentages of the board: centred under the dice. The
 * button is HTML laid over the board, so it stays a button of a usable size when the board is
 * scaled down on a phone. That size does not shrink with the board, so on a phone the button
 * reaches past the middle strip over the tops of the bottom row's stacks: only a button that is
 * shown when no checker can be moved (Roll is) may go here.
 */
export function underDiceSpot(): { left: string; top: string } {
  const top = DICE_CENTRE.y + DIE_SIZE / 2 + ROLL_GAP;
  return percentOfBoard(DICE_CENTRE.x, top);
}

/**
 * The middle of the gap between the two trays: the column of the trays, halfway down. Nothing
 * is drawn there, and the dice, which are towards the other side, stay clear even when there
 * are four.
 */
export const BETWEEN_TRAYS: Xy = {
  x: TRAY_X + TRAY_WIDTH / 2,
  y: (trayY(true) + POINT_HEIGHT + trayY(false)) / 2,
};

/**
 * Where the Undo button goes, as CSS percentages of the board: its middle is `BETWEEN_TRAYS`.
 * It is a place the stacks do not reach, so the button covers no checker and no landing mark,
 * however the board is scaled.
 */
export function betweenTraysSpot(): { left: string; top: string } {
  return percentOfBoard(BETWEEN_TRAYS.x, BETWEEN_TRAYS.y);
}

function percentOfBoard(x: number, y: number): { left: string; top: string } {
  return {
    left: `${((x / WIDTH) * 100).toFixed(2)}%`,
    top: `${((y / HEIGHT) * 100).toFixed(2)}%`,
  };
}
// Dice that lie in a perfectly straight row look placed, not thrown.
const TILTS = [-8, 6, -4, 9];
const DRIFTS = [-4, 5, 3, -5];

export interface DieSpot extends Xy {
  /** Degrees. */
  tilt: number;
}

/** Where `count` dice (two, or four for a double) lie, in a row across the middle strip. */
export function diceSpots(count: number): DieSpot[] {
  const width = count * DIE_SIZE + (count - 1) * DIE_GAP;
  return Array.from({ length: count }, (_, i) => ({
    x: DICE_CENTRE.x - width / 2 + DIE_SIZE / 2 + i * (DIE_SIZE + DIE_GAP),
    y: DICE_CENTRE.y + (DRIFTS[i % DRIFTS.length] ?? 0),
    tilt: TILTS[i % TILTS.length] ?? 0,
  }));
}
