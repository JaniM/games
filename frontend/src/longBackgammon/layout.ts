import { type Landing, type LongBackgammonState, type Seat, type Step, landing } from "../features/game";

export { landing };
export type { Landing };

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

/**
 * The number both players call a point by, whoever is looking: the physical numbering of
 * the rules (`docs/games/long-backgammon.md`), in which White's head is 24 and Black's is
 * 12, White's home is 1 to 6 and Black's is 13 to 18. `k` is the number that `seat` counts
 * the point by, and `white` is the seat that moves first.
 */
export function pointNumber(k: number, seat: Seat, white: Seat): number {
  return 25 - toViewerIndex(k, seat, white);
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

/**
 * The step that bears the selected checker `picked` off, or null if no die does. When two
 * different dice could, it is the one with the larger die (D8 in the rules doc), so that the
 * player is never asked which: there is one button for it, and it shows no die.
 */
export function bearOffStep(picked: number | null, ways: readonly Destination[]): Step | null {
  if (picked === null) return null;
  const dice = ways.filter((way) => way.to === "off").map((way) => way.die);
  return dice.length > 0 ? { from: picked, die: Math.max(...dice) } : null;
}

/** What pressing on a point does. */
export type Press =
  | { type: "select"; point: number }
  | { type: "move"; step: Step }
  | { type: "none" };

/**
 * What a press on the viewer's point `point` does. A point has two parts: its pieces and
 * its background (the triangle and the marker that shows where the selected checker would
 * land). Pressing a piece only ever selects it, so that a stack can be picked up even where
 * the selected checker could land. Only the background moves the selected checker there.
 * The background of a point that is no landing place selects its checkers, if it has any
 * that can move, as the pieces do.
 *
 * `ways` are the destinations of the selected checker `picked`, and `sources` the points
 * that checkers can start from.
 */
export function pressOutcome(
  on: "piece" | "background",
  point: number,
  picked: number | null,
  ways: readonly Destination[],
  sources: ReadonlySet<number>,
): Press {
  if (on === "background" && picked !== null) {
    const way = ways.find((w) => w.to === point);
    if (way) return { type: "move", step: { from: picked, die: way.die } };
  }
  return sources.has(point) ? { type: "select", point } : { type: "none" };
}

/** One die as it is drawn. */
export interface DieFace {
  value: number;
  /** Already played this turn. */
  used: boolean;
}

/**
 * The dice on the board. During a turn they are its dice: a double shows four, since it is
 * played four times, and the first ones are the used ones. Between turns the dice of the
 * turn just played lie where they fell, all of them used, until the next roll. Before
 * anybody has rolled there are none.
 */
export function diceFaces(state: LongBackgammonState): DieFace[] {
  const { phase } = state;
  if (phase.type === "move") {
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
  if (!state.lastTurn) return [];
  const [a, b] = state.lastTurn.dice;
  return (a === b ? [a, a, a, a] : [a, b]).map((value) => ({ value, used: true }));
}
