import { useOp } from "millpond/react";
import { useEffect } from "react";
import { loadGames } from "../features/lobby";
import { GAMES } from "../games";
import { HomeScreen } from "./HomeScreen";

/** The front page, which reads the user's games each time it opens. */
export function Home() {
  const load = useOp(loadGames);

  // Each time the page opens, so a game made elsewhere or since shows up. Once per visit:
  // `load` is the same function until the db changes.
  useEffect(() => {
    load();
  }, [load]);

  return <HomeScreen games={GAMES} />;
}
