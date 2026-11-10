import { useOp } from "millpond/react";
import { useEffect } from "react";
import { loadPublicGames } from "../features/lobby";
import { GAMES } from "../games";
import { PublicGamesScreen } from "./PublicGamesScreen";

/** The public list, which is read each time the page opens. */
export function PublicGames() {
  const load = useOp(loadPublicGames);

  // Each time the page opens, so a game made since shows up. Once per visit: `load` is the
  // same function until the db changes.
  useEffect(() => {
    load();
  }, [load]);

  return <PublicGamesScreen games={GAMES} />;
}
