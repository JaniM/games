import type { RowOf } from "millpond";
import { useOp, useQuery } from "millpond/react";
import { useMemo } from "react";
import { GameRow, gameState } from "../components/GameRow";
import { Loading } from "../components/Loading";
import { PUBLIC_LIST_ID, loadPublicGames, publicGames, publicList } from "../features/lobby";
import type { GameInfo } from "../games";
import { playerName } from "../playerName";

export type PublicGameRow = RowOf<typeof publicGames>;
export type PublicListRow = RowOf<typeof publicList>;

export interface PublicGamesScreenProps {
  /** The games the site offers: they name the kinds of game listed. */
  games: readonly GameInfo[];
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
 * The public list: the games that players chose to share, as links to watch them. It reads the
 * list from the lobby.
 */
export function PublicGamesScreen({ games }: PublicGamesScreenProps) {
  // Whether the list is being read; undefined before the first read starts.
  const list = useQuery(publicList.get(PUBLIC_LIST_ID));
  // Every kind of game, oldest first: the index on `updatedAt`.
  const oldestFirst = useQuery(publicGames.byUpdated.updatedAtGte(0));
  const listed = useMemo(() => [...oldestFirst].reverse(), [oldestFirst]);
  const load = useOp(loadPublicGames);
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
          <button className="button button-quiet" type="button" onClick={() => load()}>
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
