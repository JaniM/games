import type { LongBackgammonState, Phase, Seat, Step } from "../features/game";

// Geometry and legal-move helpers for drawing the board. None of it knows a rule: the
// server's `legal` list says what can be played, and this only arranges it for the eye.

/**
 * Each player counts the points of the ring from their own head (1) to their home (24).
 * The same point is `k` for one player and `k + 12` (or `k - 12`) for the other.
 */
export function otherIndex(k: number): number {
  return k <= 12 ? k + 12 : k - 12;
}

/**
 * Where a point that `seat` calls `k` is for `viewer`. A viewer's own point is the
 * same number, and the other player's is the other player's number for it.
 */
export function toViewerIndex(k: number, seat: number, viewer: number): number {
  return seat === viewer ? k : otherIndex(k);
}

export type Colour = "white" | "black";

/** What stands on one point, from the viewer's side. A point never holds both players' checkers. */
export interface PointView {
  /** The viewer's number for the point, 1..24. */
  index: number;
  owner: "me" | "them" | null;
  count: number;
}

/**
 * The 24 points as the viewer counts them. Without a state (the game has not started) it
 * is the starting position: both players' fifteen checkers on their own heads.
 */
export function viewerPoints(state: LongBackgammonState | null, viewer: Seat): PointView[] {
  const other = (1 - viewer) as Seat;
  return Array.from({ length: 24 }, (_, i): PointView => {
    const index = i + 1;
    const mine = state ? (state.points[viewer][index - 1] ?? 0) : index === 1 ? 15 : 0;
    const theirs = state
      ? (state.points[other][otherIndex(index) - 1] ?? 0)
      : index === 13
        ? 15
        : 0;
    if (mine > 0) return { index, owner: "me", count: mine };
    if (theirs > 0) return { index, owner: "them", count: theirs };
    return { index, owner: null, count: 0 };
  });
}

/**
 * Where the viewer's point `k` is drawn. Point 1 (their head) is top right and the
 * numbers run right to left along the top, then left to right along the bottom, so point
 * 24 is bottom right and the home (19..24) is the bottom right quadrant. `column` counts
 * from the left, 0..11.
 */
export function pointSlot(k: number): { row: "top" | "bottom"; column: number } {
  return k <= 12 ? { row: "top", column: 12 - k } : { row: "bottom", column: k - 13 };
}

/** The colour of a seat's checkers: White is the seat that moves first. */
export function colourOf(
  seat: Seat,
  state: LongBackgammonState | null,
  viewer: Seat,
): Colour {
  // Before the start nobody is White yet. Show the viewer as White, as a placeholder.
  const white = state ? state.white : viewer;
  return seat === white ? "white" : "black";
}

/** Where a step of the player to move ends, as they count: a point, or off the board. */
export type Landing = number | "off";

export function landing(step: Step): Landing {
  const to = step.from + step.die;
  return to >= 25 ? "off" : to;
}

/** A way to play one die with the selected checker. */
export interface Destination {
  die: number;
  to: Landing;
}

/** The points the mover may start a step from. */
export function sourcePoints(state: LongBackgammonState): Set<number> {
  return new Set(state.legal.map((step) => step.from));
}

/**
 * The ways to play the checker on `from`, one per die. Two dice can reach the same
 * place only when bearing off, and then the player has to say which one to spend.
 */
export function destinations(state: LongBackgammonState, from: number): Destination[] {
  const seen = new Set<number>();
  const result: Destination[] = [];
  for (const step of state.legal) {
    if (step.from !== from || seen.has(step.die)) continue;
    seen.add(step.die);
    result.push({ die: step.die, to: landing(step) });
  }
  return result.sort((a, b) => a.die - b.die);
}

/** One die as it is drawn. */
export interface DieFace {
  value: number;
  /** Already played this turn. */
  used: boolean;
}

/**
 * The dice of the turn in progress. A double shows four, since it is played four times;
 * the first ones are the used ones. Without a roll there is nothing to show.
 */
export function diceFaces(phase: Phase): DieFace[] {
  if (phase.type !== "move") return [];
  const [a, b] = phase.dice;
  if (a === b) {
    const used = Math.max(0, 4 - phase.remaining.length);
    return Array.from({ length: 4 }, (_, i) => ({ value: a, used: i < used }));
  }
  const left = [...phase.remaining];
  return [a, b].map((value) => {
    const at = left.indexOf(value);
    if (at === -1) return { value, used: true };
    left.splice(at, 1);
    return { value, used: false };
  });
}
