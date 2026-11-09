import type { RowOf } from "millpond";
import { GAME_STATE_TEXT, GameRow, gameState } from "../GameRow";
import { Modal } from "../Modal";
import type { gamesList, myGames, newGame } from "../features/lobby";
import type { GameInfo } from "../games";
import { playerName } from "../playerName";

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
  /** Ticks or unticks "public game" in the dialog. */
  onPublic: (isPublic: boolean) => void;
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
  onPublic,
  onCreate,
  onClose,
  onReload,
}: HomeScreenProps) {
  const requestInfo = request && games.find((game) => game.id === request.kind);

  return (
    <main className="page page-wide">
      {/* The nav says where you are, so the page shows no title: only a screen reader gets one. */}
      <h1 className="visually-hidden">Games</h1>

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
          title={`${requestInfo?.name ?? request.kind}`}
          locked={request.state === "creating"}
          onClose={onClose}
        >
          <NewGameForm
            request={request}
            info={requestInfo}
            onOpponent={onOpponent}
            onPublic={onPublic}
            onCreate={onCreate}
            onClose={onClose}
          />
        </Modal>
      )}
    </main>
  );
}

/**
 * Who is in a game, by seat: "Ada (you) vs Grace (guest)". As on the game page, you are "You" if
 * you have no name, another player without one is "Player 2", and another player who is a guest is
 * marked as one (see `playerName`).
 */
export function playersText(game: Pick<MyGameRow, "seat" | "playerNames" | "playerGuests">): string {
  return game.playerNames
    .map((name, seat) => {
      if (seat === game.seat) return name ? `${name} (you)` : "You";
      return playerName(name, game.playerGuests[seat] ?? false, seat);
    })
    .join(" vs ");
}

/** Where a game stands: waiting for an opponent, in progress, or finished. */
export function gameStateText(game: Pick<MyGameRow, "started" | "finished">): string {
  return GAME_STATE_TEXT[gameState(game)];
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
            <GameRow
              gameId={game.gameId}
              name={info.name}
              players={playersText(game)}
              state={gameState(game)}
              updatedAt={game.updatedAt}
            />
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
  onPublic: (isPublic: boolean) => void;
  onCreate: () => void;
  onClose: () => void;
}

/**
 * What goes in the dialog: what the game is, who to play (if the game has a computer opponent
 * to choose), whether it is public, and the buttons.
 */
function NewGameForm({ request, info, onOpponent, onPublic, onCreate, onClose }: NewGameFormProps) {
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
      <label className="check">
        <input
          type="checkbox"
          checked={request.public}
          disabled={creating}
          onChange={(event) => onPublic(event.target.checked)}
        />
        <span>
          <span className="check-name">Public game</span>
          <span className="check-hint muted">Listed for anyone to watch once it has started.</span>
        </span>
      </label>
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
