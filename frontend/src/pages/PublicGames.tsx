import { useOp, useQuery } from "millpond/react";
import { useEffect, useMemo } from "react";
import { PUBLIC_LIST_ID, loadPublicGames, publicGames, publicList } from "../features/lobby";
import { GAMES } from "../games";
import { PublicGamesScreen } from "./PublicGamesScreen";

/** Connects the public list to the lobby: reads the list when the page opens and shows it. */
export function PublicGames() {
  const list = useQuery(publicList.get(PUBLIC_LIST_ID));
  // Every kind of game, oldest first: the index on `updatedAt`.
  const games = useQuery(publicGames.byUpdated.updatedAtGte(0));
  const load = useOp(loadPublicGames);

  // Read the list each time the page opens, so a game made since shows up. Once per visit:
  // `load` is the same function until the db changes.
  useEffect(() => {
    load();
  }, [load]);

  const newestFirst = useMemo(() => [...games].reverse(), [games]);

  return <PublicGamesScreen games={GAMES} listed={newestFirst} list={list} onReload={() => load()} />;
}
