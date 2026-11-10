import type { RowOf } from "millpond";
import { useOp, useQuery } from "millpond/react";
import { useMemo } from "react";
import { GAME_STATE_TEXT, GameRow, gameState } from "../components/GameRow";
import { Loading } from "../components/Loading";
import { Modal } from "../components/Modal";
import {
  BOT_LEVELS,
  type BotLevel,
  GAMES_LIST_ID,
  NEW_GAME_ID,
  chooseLevel,
  chooseOpponent,
  choosePublic,
  closeNewGame,
  createGame,
  gamesList,
  loadGames,
  myGames,
  newGame,
  openNewGame,
} from "../features/lobby";
import type { GameInfo } from "../games";
import { playerName } from "../playerName";

export type MyGameRow = RowOf<typeof myGames>;
export type GamesListRow = RowOf<typeof gamesList>;
export type NewGameRow = RowOf<typeof newGame>;

export interface HomeScreenProps {
  /** The games the site offers. */
  games: readonly GameInfo[];
}

/**
 * The front page: the user's games at the left edge, the games to start in the middle, and the
 * dialog for starting one. Each part reads what it shows from the lobby, and its buttons call the
 * lobby's ops.
 */
export function HomeScreen({ games }: HomeScreenProps) {
  const open = useOp(openNewGame);

  return (
    <main className="page page-home">
      {/* The nav says where you are, so the page shows no title: only a screen reader gets one. */}
      <h1 className="visually-hidden">Games</h1>

      <div className="home">
        <MyGames games={games} />

        <section className="home-catalog" aria-labelledby="catalog-title">
          <h2 id="catalog-title" className="section-title">
            Start a game
          </h2>
          <ul className="game-list">
            {games.map((game) => (
              <li key={game.id}>
                <button className="game-card" type="button" onClick={() => open({ kind: game.id })}>
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

      <NewGameDialog games={games} />
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

/** The user's games, as links to their pages. A game of a kind the site doesn't know has no page, so it is left out. */
function MyGames({ games }: { games: readonly GameInfo[] }) {
  // Whether the games are being read; undefined before the first read starts.
  const list = useQuery(gamesList.get(GAMES_LIST_ID));
  // Every kind of game, oldest first: the index on `updatedAt`.
  const oldestFirst = useQuery(myGames.byUpdated.updatedAtGte(0));
  const mine = useMemo(() => [...oldestFirst].reverse(), [oldestFirst]);
  const load = useOp(loadGames);
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
          <button className="button button-quiet" type="button" onClick={() => load()}>
            Try again
          </button>
        </div>
      )}
      {shown.length === 0 && loaded && <p className="muted">You have no games yet.</p>}
      {shown.length === 0 && !loaded && list?.state !== "failed" && <Loading className="muted" />}
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

/** What each level of the bot is called in the dialog. */
const LEVEL_NAMES: Record<BotLevel, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

/**
 * The dialog for creating a game, while the user has one open: what the game is, who to play (if
 * the game has a computer opponent to choose) and, against the computer, how well it plays,
 * whether the game is public, and the buttons.
 */
function NewGameDialog({ games }: { games: readonly GameInfo[] }) {
  const request = useQuery(newGame.get(NEW_GAME_ID));
  const opponent = useOp(chooseOpponent);
  const level = useOp(chooseLevel);
  const makePublic = useOp(choosePublic);
  const create = useOp(createGame);
  const close = useOp(closeNewGame);
  if (!request) return null;

  // The catalog entry for the kind, if the site has one.
  const info = games.find((game) => game.id === request.kind);
  const creating = request.state === "creating";
  // Only a game the catalog knows can say it has a bot. Without one, a friend is the only choice.
  const bot = info?.bot === true && request.bot;
  return (
    <Modal title={info?.name ?? request.kind} locked={creating} onClose={() => close()}>
      {info && <p>{info.description}</p>}
      {info?.bot ? (
        <fieldset className="choice" disabled={creating}>
          <legend className="visually-hidden">Opponent</legend>
          <label className="choice-option">
            <input type="radio" name="opponent" checked={!bot} onChange={() => opponent({ bot: false })} />
            <span className="choice-name">Play vs a friend</span>
          </label>
          <label className="choice-option">
            <input type="radio" name="opponent" checked={bot} onChange={() => opponent({ bot: true })} />
            <span className="choice-name">Play vs a bot</span>
          </label>
        </fieldset>
      ) : (
        <p className="muted">
          {info ? `${info.players}. ` : ""}You get a link to send to your opponent. Anyone who has
          it can watch.
        </p>
      )}
      {bot && (
        <fieldset className="segmented" disabled={creating}>
          <legend className="visually-hidden">Level</legend>
          {BOT_LEVELS.map((choice) => (
            <label key={choice} className="segmented-option">
              <input
                className="visually-hidden"
                type="radio"
                name="level"
                checked={request.level === choice}
                onChange={() => level({ level: choice })}
              />
              <span className="segmented-name">{LEVEL_NAMES[choice]}</span>
            </label>
          ))}
        </fieldset>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={request.public}
          disabled={creating}
          onChange={(event) => makePublic({ public: event.target.checked })}
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
        <button className="button button-quiet" type="button" disabled={creating} onClick={() => close()}>
          Cancel
        </button>
        <button
          className="button"
          type="button"
          data-autofocus
          disabled={creating}
          aria-busy={creating}
          onClick={() => create()}
        >
          {creating ? "Creating…" : "Create game"}
        </button>
      </div>
    </Modal>
  );
}
