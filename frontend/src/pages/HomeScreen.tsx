import type { RowOf } from "millpond";
import { Link } from "../Link";
import { Modal } from "../Modal";
import type { gamesList, myGames, newGame } from "../features/lobby";
import { gamePath } from "../features/router";
import type { GameInfo } from "../games";

export type MyGameRow = RowOf<typeof myGames>;
export type GamesListRow = RowOf<typeof gamesList>;
export type NewGameRow = RowOf<typeof newGame>;

export interface HomeScreenProps {
  /** The games the site offers. */
  games: readonly GameInfo[];
  /** The games the user is in, newest first. */
  mine: readonly MyGameRow[];
  /** Whether `mine` is being read; undefined before the first read starts. */
  list: GamesListRow | undefined;
  /** The dialog for creating a game; undefined while it is closed. */
  request: NewGameRow | undefined;
  onNewGame: (kind: string) => void;
  /** Picks the opponent in the dialog: the computer (true), or a friend. */
  onOpponent: (bot: boolean) => void;
  onCreate: () => void;
  onClose: () => void;
  onReload: () => void;
}

/**
 * The front page: the user's games on the left, the games to start on the right, and the
 * dialog for starting one. Everything it shows comes from its props, so it can be
 * rendered without a db.
 */
export function HomeScreen({
  games,
  mine,
  list,
  request,
  onNewGame,
  onOpponent,
  onCreate,
  onClose,
  onReload,
}: HomeScreenProps) {
  const requestInfo = request && games.find((game) => game.id === request.kind);

  return (
    <main className="page page-wide">
      <header className="page-header">
        <h1>Games</h1>
        <p>Simple board games, played live or at your own pace.</p>
      </header>

      <div className="home">
        <MyGames games={games} mine={mine} list={list} onReload={onReload} />

        <section className="home-catalog" aria-labelledby="catalog-title">
          <h2 id="catalog-title" className="section-title">
            Start a game
          </h2>
          <ul className="game-list">
            {games.map((game) => (
              <li key={game.id}>
                <button className="game-card" type="button" onClick={() => onNewGame(game.id)}>
                  <span className="game-card-title">{game.name}</span>
                  <span className="game-card-text">{game.description}</span>
                  <span className="game-card-footer">
                    <span>{game.players}</span>
                    <span className="game-card-play" aria-hidden="true">
                      Play →
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {request && (
        <Modal
          title={`New game: ${requestInfo?.name ?? request.kind}`}
          locked={request.state === "creating"}
          onClose={onClose}
        >
          <NewGameForm
            request={request}
            info={requestInfo}
            onOpponent={onOpponent}
            onCreate={onCreate}
            onClose={onClose}
          />
        </Modal>
      )}
    </main>
  );
}

/**
 * Who is in a game, by seat: "Ada (you) vs Grace". As on the game page, you are "You" if you
 * have no name, and another player without one is "Player 2".
 */
export function playersText(game: Pick<MyGameRow, "seat" | "playerNames">): string {
  return game.playerNames
    .map((name, seat) => {
      if (seat === game.seat) return name ? `${name} (you)` : "You";
      return name ?? `Player ${seat + 1}`;
    })
    .join(" vs ");
}

/** Where a game stands: waiting for an opponent, in progress, or finished. */
export function gameStateText(game: Pick<MyGameRow, "started" | "finished">): string {
  if (game.finished) return "Finished";
  return game.started ? "In progress" : "Waiting for an opponent";
}

/** The same three states as a word for the stylesheet, which draws each with its own dot. */
function gameStateKind(game: Pick<MyGameRow, "started" | "finished">): "done" | "live" | "waiting" {
  if (game.finished) return "done";
  return game.started ? "live" : "waiting";
}

interface MyGamesProps {
  games: readonly GameInfo[];
  mine: readonly MyGameRow[];
  list: GamesListRow | undefined;
  onReload: () => void;
}

/** The user's games, as links to their pages. A game of a kind the site doesn't know has no page, so it is left out. */
function MyGames({ games, mine, list, onReload }: MyGamesProps) {
  const shown = mine.flatMap((game) => {
    const info = games.find((info) => info.id === game.kind);
    return info ? [{ game, info }] : [];
  });
  const loaded = list?.state === "loaded";

  return (
    <section className="home-games" aria-labelledby="my-games-title">
      <h2 id="my-games-title" className="section-title">
        Your games
      </h2>
      {list?.state === "failed" && (
        <div role="alert">
          <p className="error">Could not load your games: {list.error}</p>
          <button className="button button-quiet" type="button" onClick={onReload}>
            Try again
          </button>
        </div>
      )}
      {shown.length === 0 && loaded && <p className="muted">You have no games yet.</p>}
      {shown.length === 0 && !loaded && list?.state !== "failed" && <p className="muted">Loading…</p>}
      <ul className="my-games">
        {shown.map(({ game, info }) => (
          <li key={game.gameId}>
            <Link className="my-game" to={gamePath(game.gameId)}>
              <span className="my-game-name">{info.name}</span>
              <span className="my-game-players">{playersText(game)}</span>
              {/* Where the game stands and when it last changed share a row. */}
              <span className="my-game-meta">
                <span className={`my-game-state my-game-state-${gameStateKind(game)}`}>
                  {gameStateText(game)}
                </span>
                <time className="muted" dateTime={new Date(game.updatedAt).toISOString()}>
                  {new Date(game.updatedAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface NewGameFormProps {
  request: NewGameRow;
  /** The catalog entry for the kind, if the site has one. */
  info: GameInfo | undefined;
  onOpponent: (bot: boolean) => void;
  onCreate: () => void;
  onClose: () => void;
}

/**
 * What goes in the dialog: what the game is, who to play (if the game has a computer opponent
 * to choose), and the buttons.
 */
function NewGameForm({ request, info, onOpponent, onCreate, onClose }: NewGameFormProps) {
  const creating = request.state === "creating";
  // Only a game the catalog knows can say it has a bot. Without one, a friend is the only choice.
  const bot = info?.bot === true && request.bot;
  return (
    <>
      {info && <p>{info.description}</p>}
      {info?.bot ? (
        <fieldset className="choice" disabled={creating}>
          <legend className="visually-hidden">Opponent</legend>
          <label className="choice-option">
            <input type="radio" name="opponent" checked={!bot} onChange={() => onOpponent(false)} />
            <span className="choice-name">Play vs a friend</span>
          </label>
          <label className="choice-option">
            <input type="radio" name="opponent" checked={bot} onChange={() => onOpponent(true)} />
            <span className="choice-name">Play vs a bot</span>
          </label>
        </fieldset>
      ) : (
        <p className="muted">
          {info ? `${info.players}. ` : ""}You get a link to send to your opponent. Anyone who has
          it can watch.
        </p>
      )}
      {request.state === "failed" && (
        <p className="error" role="alert">
          Could not create the game: {request.error}
        </p>
      )}
      <div className="modal-actions">
        <button className="button button-quiet" type="button" disabled={creating} onClick={onClose}>
          Cancel
        </button>
        <button
          className="button"
          type="button"
          data-autofocus
          disabled={creating}
          aria-busy={creating}
          onClick={onCreate}
        >
          {creating ? "Creating…" : "Create game"}
        </button>
      </div>
    </>
  );
}
