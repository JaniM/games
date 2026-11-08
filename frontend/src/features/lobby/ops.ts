import { op } from "millpond";
import type { z } from "zod";
import type { gamesReplySchema } from "./schemas";
import { GAMES_LIST_ID, NEW_GAME_ID, gamesList, myGames, newGame } from "./tables";

/**
 * Opens the dialog for creating a game of `kind`. Ignored while a game is being created,
 * since that dialog is already open. Opening it again after a failure starts afresh.
 */
export const openNewGame = op((tx, args: { kind: string }) => {
  if (tx.read(newGame.get(NEW_GAME_ID))?.state === "creating") return;
  tx.upsert(newGame, { id: NEW_GAME_ID, state: "choosing", kind: args.kind, bot: false, error: null });
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
