import { feature } from "millpond";
import {
  createGameRequest,
  loadGamesList,
  loadPublicGamesList,
  persistLobbySettings,
} from "./effects";
import {
  chooseOpponent,
  choosePublic,
  closeNewGame,
  createGame,
  forgetGames,
  gameCreateFailed,
  gameCreated,
  gamesLoadFailed,
  gamesLoaded,
  loadGames,
  loadPublicGames,
  openNewGame,
  publicGamesLoadFailed,
  publicGamesLoaded,
  startLobby,
} from "./ops";
import { gamesList, lobbySettings, myGames, newGame, publicGames, publicList } from "./tables";

export const lobby = feature({
  tables: { newGame, gamesList, myGames, lobbySettings, publicList, publicGames },
  ops: {
    startLobby,
    openNewGame,
    chooseOpponent,
    choosePublic,
    createGame,
    closeNewGame,
    gameCreated,
    gameCreateFailed,
    loadGames,
    forgetGames,
    gamesLoaded,
    gamesLoadFailed,
    loadPublicGames,
    publicGamesLoaded,
    publicGamesLoadFailed,
  },
  effects: { createGameRequest, loadGamesList, loadPublicGamesList, persistLobbySettings },
});

// Components import definitions by value; they never need the assembled db.
export {
  chooseOpponent,
  choosePublic,
  closeNewGame,
  createGame,
  forgetGames,
  loadGames,
  loadPublicGames,
  openNewGame,
  startLobby,
} from "./ops";
export { loadPublic } from "./storage";
export {
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
