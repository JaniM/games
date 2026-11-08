import { feature } from "millpond";
import { createGameRequest, loadGamesList } from "./effects";
import {
  chooseOpponent,
  closeNewGame,
  createGame,
  gameCreateFailed,
  gameCreated,
  gamesLoadFailed,
  gamesLoaded,
  loadGames,
  openNewGame,
} from "./ops";
import { gamesList, myGames, newGame } from "./tables";

export const lobby = feature({
  tables: { newGame, gamesList, myGames },
  ops: {
    openNewGame,
    chooseOpponent,
    createGame,
    closeNewGame,
    gameCreated,
    gameCreateFailed,
    loadGames,
    gamesLoaded,
    gamesLoadFailed,
  },
  effects: { createGameRequest, loadGamesList },
});

// Components import definitions by value; they never need the assembled db.
export { chooseOpponent, closeNewGame, createGame, loadGames, openNewGame } from "./ops";
export { GAMES_LIST_ID, NEW_GAME_ID, gamesList, myGames, newGame } from "./tables";
