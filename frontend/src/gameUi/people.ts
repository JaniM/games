import type { Players, Seat } from "../features/game";
import { playerName } from "../playerName";

// The words about the people in a game, whatever the game: who is who in a sentence, and where
// the rematch stands. Each game's own `status.ts` adds the words about its board.

/**
 * A seat in a sentence: "You", the player's name ("Grace (guest)" for a guest, see `playerName`),
 * or "Player 2" if they have none.
 */
export function nameOf(snapshot: Players, seat: Seat, mySeat: Seat | null): string {
  if (seat === mySeat) return "You";
  return playerName(snapshot.playerNames[seat], snapshot.playerGuests[seat] ?? false, seat);
}

/** A seat for the bar above or below the board. An empty seat is waiting. */
export function barNameOf(snapshot: Players, seat: Seat, mySeat: Seat | null): string {
  if (seat >= snapshot.players.length) return "Waiting for an opponent…";
  const name = snapshot.playerNames[seat];
  // Your own seat says "(you)", which says it all: you know whether you are a guest.
  if (seat === mySeat) return name ? `${name} (you)` : "You";
  return playerName(name, snapshot.playerGuests[seat] ?? false, seat);
}

/** How a game ended, in two parts: who won, and what it was worth. */
export interface Result {
  /** "You won", "Ada won" or "Draw". */
  title: string;
  /** "1 point", "Mars: 2 points", "Grace forfeited", or "" when there is nothing to add. */
  detail: string;
  /** The loser gave up, so `detail` says who. */
  forfeited: boolean;
  /** The viewer is a player, and it was them. */
  won: boolean;
}

/**
 * A result's detail in the middle of a sentence: "mars: 2 points", "you forfeited". A name
 * keeps its capital: "Grace forfeited".
 */
export function inSentence(result: Result): string {
  return result.forfeited ? result.detail.replace(/^You\b/, "you") : result.detail.toLowerCase();
}

/**
 * What the viewer can do about the rematch of a finished game, and what to tell them:
 *
 * - `closed`: nothing. They only watch, and there is no rematch yet.
 * - `ask`: they can ask for one. `line` says so if their last ask was turned down.
 * - `waiting`: they have asked, and the other player has not answered. They can take it back.
 * - `answer`: the other player has asked. They can say yes or no.
 * - `started`: the new game exists. Anyone can go there.
 */
export type RematchStage =
  | { stage: "closed"; line: "" }
  | { stage: "ask"; line: string }
  | { stage: "waiting"; line: string }
  | { stage: "answer"; line: string }
  | { stage: "started"; line: string; gameId: string };

/** Where the rematch stands for the viewer. Only meaningful once the game is over. */
export function rematchStage(snapshot: Players, mySeat: Seat | null): RematchStage {
  const rematch = snapshot.rematch;
  if (rematch?.type === "accepted") {
    return { stage: "started", line: "The rematch has started.", gameId: rematch.gameId };
  }
  if (mySeat === null || snapshot.players.length < 2) return { stage: "closed", line: "" };

  const other = (1 - mySeat) as Seat;
  const name = nameOf(snapshot, other, mySeat);
  if (rematch?.type === "offered") {
    return rematch.by === mySeat
      ? { stage: "waiting", line: `Waiting for ${name} to accept the rematch…` }
      : { stage: "answer", line: `${name} wants a rematch.` };
  }
  // A `declined` is news only to the one who was turned down. The one who said no knows.
  const turnedDown = rematch?.type === "declined" && rematch.by === mySeat;
  return { stage: "ask", line: turnedDown ? `${name} declined the rematch.` : "" };
}

/** What a position of a game in review says about itself, in two lines. */
export interface FrameText {
  /** What led to the position: the roll or the step or the mark that was just played. */
  title: string;
  /** What else is worth knowing about it: that the game is over, and how it ended. */
  detail: string;
}
