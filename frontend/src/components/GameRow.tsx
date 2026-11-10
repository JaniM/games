import { Link } from "./Link";
import { gamePath } from "../features/router";

/** Where a game stands: being played, waiting for an opponent, or over. */
export type GameState = "live" | "waiting" | "done";

export function gameState(game: { started: boolean; finished: boolean }): GameState {
  if (game.finished) return "done";
  return game.started ? "live" : "waiting";
}

export const GAME_STATE_TEXT: Record<GameState, string> = {
  live: "In progress",
  waiting: "Waiting for an opponent",
  done: "Finished",
};

export interface GameRowProps {
  gameId: string;
  /** What kind of game it is. */
  name: string;
  /** Who plays, in words. */
  players: string;
  state: GameState;
  /** When the game last changed, in milliseconds since the epoch. */
  updatedAt: number;
}

/**
 * One game in a list, as a link to its page: the kind, the players, and below them where it
 * stands and when it last changed. The user's games and the public list are both made of these.
 * Put it in a `my-games` list.
 */
export function GameRow({ gameId, name, players, state, updatedAt }: GameRowProps) {
  return (
    <Link className="my-game" to={gamePath(gameId)}>
      <span className="my-game-name">{name}</span>
      <span className="my-game-players">{players}</span>
      {/* Where the game stands and when it last changed share a row. */}
      <span className="my-game-meta">
        <span className={`my-game-state my-game-state-${state}`}>{GAME_STATE_TEXT[state]}</span>
        <time className="muted" dateTime={new Date(updatedAt).toISOString()}>
          {new Date(updatedAt).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </time>
      </span>
    </Link>
  );
}
