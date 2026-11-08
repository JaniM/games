import { useOp, useQuery } from "millpond/react";
import { useEffect, useMemo } from "react";
import {
  GAMES_LIST_ID,
  NEW_GAME_ID,
  closeNewGame,
  createGame,
  gamesList,
  loadGames,
  myGames,
  newGame,
  openNewGame,
} from "../features/lobby";
import { GAMES } from "../games";
import { HomeScreen } from "./HomeScreen";

/** Connects the front page to the lobby: reads the user's games and turns clicks into ops. */
export function Home() {
  const list = useQuery(gamesList.get(GAMES_LIST_ID));
  const request = useQuery(newGame.get(NEW_GAME_ID));
  // Every kind of game, oldest first: the index on `updatedAt`.
  const games = useQuery(myGames.byUpdated.updatedAtGte(0));
  const load = useOp(loadGames);
  const open = useOp(openNewGame);
  const create = useOp(createGame);
  const close = useOp(closeNewGame);

  // Read the list each time the page opens, so a game made elsewhere or since shows up.
  // Once per visit: `load` is the same function until the db changes.
  useEffect(() => {
    load();
  }, [load]);

  const newestFirst = useMemo(() => [...games].reverse(), [games]);

  return (
    <HomeScreen
      games={GAMES}
      mine={newestFirst}
      list={list}
      request={request}
      onNewGame={(kind) => open({ kind })}
      onCreate={() => create()}
      onClose={() => close()}
      onReload={() => load()}
    />
  );
}
