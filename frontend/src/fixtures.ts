// Long backgammon positions for tests: the shapes the server sends, built from small pieces.

import type { LongBackgammonState, Phase, Snapshot, Step } from "./features/game";
import { gameIdOf } from "./testing";

export const GAME_ID = gameIdOf(1);

/** `count` checkers on each listed point (a player's own numbering, 1..24). */
export function board(onPoints: Record<number, number>): number[] {
  const points = Array.from({ length: 24 }, () => 0);
  for (const [point, count] of Object.entries(onPoints)) points[Number(point) - 1] = count;
  return points;
}

/** A game just started: seat 0 is White and about to roll, with all checkers on their heads. */
export function startingState(overrides: Partial<LongBackgammonState> = {}): LongBackgammonState {
  return {
    white: 0,
    points: [board({ 1: 15 }), board({ 1: 15 })],
    off: [0, 0],
    turn: 0,
    turns: [0, 0],
    lastThrow: false,
    phase: { type: "roll" },
    legal: [],
    combos: [],
    lastTurn: null,
    ...overrides,
  };
}

/**
 * The mover has rolled `dice` and has not played yet (`remaining` defaults to the dice).
 * `combos` are the lines of two or more steps by one checker that the server lists.
 */
export function moving(
  dice: [number, number],
  legal: Step[],
  played: Step[] = [],
  remaining: number[] = dice[0] === dice[1] ? [dice[0], dice[0], dice[0], dice[0]] : [...dice],
  combos: Step[][] = [],
): Pick<LongBackgammonState, "phase" | "legal" | "combos"> {
  const phase: Phase = { type: "move", dice, remaining, played };
  return { phase, legal, combos };
}

/** What a snapshot holds once the client has read it. */
export function snapshotOf(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    revision: 1,
    players: ["user-a", "user-b"],
    playerNames: ["Ada", "Grace"],
    // Both have accounts, so their names are shown as they are.
    playerGuests: [false, false],
    state: startingState(),
    rematch: null,
    ...overrides,
  };
}

/** The message the server sends: a snapshot, with its envelope. */
export function snapshotMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "snapshot",
    gameId: GAME_ID,
    kind: "long-backgammon",
    stateVersion: 1,
    ...snapshotOf(),
    ...overrides,
  };
}
