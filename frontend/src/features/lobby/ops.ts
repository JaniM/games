import { op } from "millpond";
import type { z } from "zod";
import type { gamesReplySchema, publicGamesReplySchema } from "./schemas";
import {
  DEFAULT_PUBLIC,
  GAMES_LIST_ID,
  LOBBY_SETTINGS_ID,
  NEW_GAME_ID,
  PUBLIC_LIST_ID,
  gamesList,
  lobbySettings,
  myGames,
  newGame,
  publicGames,
  publicList,
} from "./tables";

/**
 * Sets up the remembered choices once at startup, from whatever local storage held (null:
 * nothing, so the defaults). Does nothing if a choice has been made since.
 */
export const startLobby = op((tx, args: { stored: boolean | null }) => {
  if (tx.read(lobbySettings.get(LOBBY_SETTINGS_ID))) return;
  tx.insert(lobbySettings, { id: LOBBY_SETTINGS_ID, public: args.stored ?? DEFAULT_PUBLIC });
});

/**
 * Opens the dialog for creating a game of `kind`. Ignored while a game is being created,
 * since that dialog is already open. Opening it again after a failure starts afresh, with
 * "public" as the player last chose it.
 */
export const openNewGame = op((tx, args: { kind: string }) => {
  if (tx.read(newGame.get(NEW_GAME_ID))?.state === "creating") return;
  const remembered = tx.read(lobbySettings.get(LOBBY_SETTINGS_ID))?.public;
  tx.upsert(newGame, {
    id: NEW_GAME_ID,
    state: "choosing",
    kind: args.kind,
    bot: false,
    public: remembered ?? DEFAULT_PUBLIC,
    error: null,
  });
});

/**
 * Picks whether the game is in the public list, and remembers the choice for the next game.
 * Ignored with no dialog, and while a game is being created, since the request has gone out as
 * it was.
 */
export const choosePublic = op((tx, args: { public: boolean }) => {
  const request = tx.read(newGame.get(NEW_GAME_ID));
  if (!request || request.state === "creating") return;
  tx.update(newGame, NEW_GAME_ID, { public: args.public });
  tx.upsert(lobbySettings, { id: LOBBY_SETTINGS_ID, public: args.public });
});

/**
 * Asks the `createGameRequest` effect to create the game the dialog is open for. Ignored
 * with no dialog, and while one is being created, so pressing the button twice makes one game.
 */
export const createGame = op((tx) => {
  const request = tx.read(newGame.get(NEW_GAME_ID));
  if (!request || request.state === "creating") return;
  tx.update(newGame, NEW_GAME_ID, { state: "creating", error: null });
});

/**
 * Picks who to play against: the computer, or a friend who follows a link. Ignored with no
 * dialog, and while a game is being created, since the request has gone out as it was.
 */
export const chooseOpponent = op((tx, args: { bot: boolean }) => {
  const request = tx.read(newGame.get(NEW_GAME_ID));
  if (!request || request.state === "creating") return;
  tx.update(newGame, NEW_GAME_ID, { bot: args.bot });
});

/** Closes the dialog. Ignored while a game is being created: that can't be taken back. */
export const closeNewGame = op((tx) => {
  const request = tx.read(newGame.get(NEW_GAME_ID));
  if (request && request.state !== "creating") tx.delete(newGame, NEW_GAME_ID);
});

/** Records a created game. */
export const gameCreated = op((tx) => {
  if (tx.read(newGame.get(NEW_GAME_ID))) tx.delete(newGame, NEW_GAME_ID);
});

/** Records a game that could not be created. */
export const gameCreateFailed = op((tx, args: { error: string }) => {
  if (!tx.read(newGame.get(NEW_GAME_ID))) return;
  tx.update(newGame, NEW_GAME_ID, { state: "failed", error: args.error });
});

/** Asks the `loadGamesList` effect to read the user's games. Calling it again restarts the read. */
export const loadGames = op((tx) => {
  tx.upsert(gamesList, { id: GAMES_LIST_ID, state: "loading", error: null });
});

/**
 * Drops the games shown and reads them again, because the user is someone else now (they signed
 * in or out, or deleted themselves). The `loadGamesList` effect reads once the session is ready.
 */
export const forgetGames = op((tx) => {
  for (const game of tx.read(myGames.all())) tx.delete(myGames, game.gameId);
  tx.upsert(gamesList, { id: GAMES_LIST_ID, state: "loading", error: null });
});

/** Replaces the user's games with what the server listed. */
export const gamesLoaded = op((tx, args: { games: z.infer<typeof gamesReplySchema>["games"] }) => {
  const listed = new Set(args.games.map((game) => game.gameId));
  for (const game of tx.read(myGames.all())) {
    if (!listed.has(game.gameId)) tx.delete(myGames, game.gameId);
  }
  for (const game of args.games) tx.upsert(myGames, game);
  tx.upsert(gamesList, { id: GAMES_LIST_ID, state: "loaded", error: null });
});

/** Records a read that did not work. The games already shown stay. */
export const gamesLoadFailed = op((tx, args: { error: string }) => {
  tx.upsert(gamesList, { id: GAMES_LIST_ID, state: "failed", error: args.error });
});

/** Asks the `loadPublicGamesList` effect to read the public list. Calling it again restarts the read. */
export const loadPublicGames = op((tx) => {
  tx.upsert(publicList, { id: PUBLIC_LIST_ID, state: "loading", error: null });
});

/** Replaces the public games shown with what the server listed. */
export const publicGamesLoaded = op(
  (tx, args: { games: z.infer<typeof publicGamesReplySchema>["games"] }) => {
    const listed = new Set(args.games.map((game) => game.gameId));
    for (const game of tx.read(publicGames.all())) {
      if (!listed.has(game.gameId)) tx.delete(publicGames, game.gameId);
    }
    for (const game of args.games) tx.upsert(publicGames, game);
    tx.upsert(publicList, { id: PUBLIC_LIST_ID, state: "loaded", error: null });
  },
);

/** Records a read of the public list that did not work. The games already shown stay. */
export const publicGamesLoadFailed = op((tx, args: { error: string }) => {
  tx.upsert(publicList, { id: PUBLIC_LIST_ID, state: "failed", error: args.error });
});
