import type { RowOf } from "millpond";
import { GameRow, gameState } from "../GameRow";
import { Loading } from "../Loading";
import type { publicGames, publicList } from "../features/lobby";
import type { GameInfo } from "../games";
import { playerName } from "../playerName";

export type PublicGameRow = RowOf<typeof publicGames>;
export type PublicListRow = RowOf<typeof publicList>;

export interface PublicGamesScreenProps {
  /** The games the site offers: they name the kinds of game listed. */
  games: readonly GameInfo[];
  /** The public games, newest change first. */
  listed: readonly PublicGameRow[];
  /** Whether `listed` is being read; undefined before the first read starts. */
  list: PublicListRow | undefined;
  onReload: () => void;
}

/**
 * Who plays a public game, by seat: "Ada vs Grace (guest)". The reader is nobody in particular,
 * so no one is "You". A player without a name is "Player 2", and a guest is marked as one (see
 * `playerName`).
 */
export function publicPlayersText(game: Pick<PublicGameRow, "playerNames" | "playerGuests">): string {
  return game.playerNames
    .map((name, seat) => playerName(name, game.playerGuests[seat] ?? false, seat))
    .join(" vs ");
}

/**
 * The public list: the games that players chose to share, as links to watch them. Everything it
 * shows comes from its props, so it can be rendered without a db.
 */
export function PublicGamesScreen({ games, listed, list, onReload }: PublicGamesScreenProps) {
  // A game of a kind the site doesn't know has no page, so it is left out.
  const shown = listed.flatMap((game) => {
    const info = games.find((info) => info.id === game.kind);
    return info ? [{ game, info }] : [];
  });
  const loaded = list?.state === "loaded";

  return (
    <main className="page page-wide">
      {/* The nav says where you are, so the page shows no title: only a screen reader gets one. */}
      <h1 className="visually-hidden">Public games</h1>

      {list?.state === "failed" && (
        <div role="alert">
          <p className="error">Could not load the public games: {list.error}</p>
          <button className="button button-quiet" type="button" onClick={onReload}>
            Try again
          </button>
        </div>
      )}
      {shown.length === 0 && loaded && <p className="muted">No public games yet.</p>}
      {shown.length === 0 && !loaded && list?.state !== "failed" && <Loading className="muted" />}
      <ul className="my-games">
        {shown.map(({ game, info }) => (
          <li key={game.gameId}>
            <GameRow
              gameId={game.gameId}
              name={info.name}
              players={publicPlayersText(game)}
              // Every listed game has started.
              state={gameState({ started: true, finished: game.finished })}
              updatedAt={game.updatedAt}
            />
          </li>
        ))}
      </ul>
    </main>
  );
}
