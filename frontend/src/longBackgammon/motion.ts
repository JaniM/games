import type { LongBackgammonState, Seat } from "../features/game";
import { toViewerIndex, viewerPoints } from "./layout";

// What happened between two positions, as far as the eye should follow it. The server
// sends positions, not events, so this works out the event from two of them.

/** One end of a checker's trip, as the viewer counts. */
export interface Place {
  /** A point (the viewer's number), or the tray of borne-off checkers. */
  at: number | "off";
  /**
   * How many checkers are there once the trip is over, or, where the checker left from,
   * before it. Its checker is the top one in either case.
   */
  count: number;
}

export type Motion =
  /** The dice were thrown. */
  | { type: "roll" }
  /** One checker moved. An undone step is the same trip the other way. */
  | { type: "move"; seat: Seat; from: Place; to: Place };

const turnsPlayed = (state: LongBackgammonState) => state.turns[0] + state.turns[1];

/** Whether `next` is what the roll of the player to move in `prev` led to. */
function isRoll(prev: LongBackgammonState, next: LongBackgammonState): boolean {
  if (prev.phase.type !== "roll") return false;
  if (next.phase.type === "move") return true;
  // A roll with nothing to play ends the turn at once, so the dice only show in `lastTurn`.
  return turnsPlayed(next) === turnsPlayed(prev) + 1 && next.lastTurn?.played.length === 0;
}

/** Where the mover's checkers moved from and to, in their own numbering, if it was one step. */
function singleStep(
  prev: LongBackgammonState,
  next: LongBackgammonState,
  seat: Seat,
): { from: number | "off"; to: number | "off" } | null {
  const other = (1 - seat) as Seat;
  if (prev.off[other] !== next.off[other]) return null;
  if (prev.points[other].some((count, i) => count !== next.points[other][i])) return null;

  const left: (number | "off")[] = [];
  const arrived: (number | "off")[] = [];
  const note = (at: number | "off", change: number) => {
    if (change === 0) return true;
    if (change === -1) left.push(at);
    else if (change === 1) arrived.push(at);
    else return false;
    return true;
  };
  for (let i = 0; i < 24; i++) {
    const change = (next.points[seat][i] ?? 0) - (prev.points[seat][i] ?? 0);
    if (!note(i + 1, change)) return null;
  }
  if (!note("off", next.off[seat] - prev.off[seat])) return null;

  const [from] = left;
  const [to] = arrived;
  if (left.length !== 1 || arrived.length !== 1 || from === undefined || to === undefined) {
    return null;
  }
  return { from, to };
}

/**
 * What the viewer should see happen on the way from `prev` to `next`, or null if nothing
 * that a drawing can follow: the very first position, a change of names, or several moves
 * at once (a reconnect that missed some), which are better shown as they are.
 */
export function motionBetween(
  prev: LongBackgammonState | null,
  next: LongBackgammonState | null,
  viewer: Seat,
): Motion | null {
  if (!prev || !next) return null;
  if (isRoll(prev, next)) return { type: "roll" };
  if (prev.phase.type !== "move") return null;

  const seat = prev.turn;
  const step = singleStep(prev, next, seat);
  if (!step) return null;

  const place = (state: LongBackgammonState, at: number | "off"): Place => {
    if (at === "off") return { at, count: state.off[seat] };
    const point = toViewerIndex(at, seat, viewer);
    return { at: point, count: viewerPoints(state, viewer)[point - 1]?.count ?? 0 };
  };
  return { type: "move", seat, from: place(prev, step.from), to: place(next, step.to) };
}
