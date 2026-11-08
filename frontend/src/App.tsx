import { useQuery } from "millpond/react";
import { NameControl } from "./NameControl";
import { LOCATION_ID, locationState, parseRoute } from "./features/router";
import { GamePage } from "./pages/GamePage";
import { Home } from "./pages/Home";
import { NotFound } from "./pages/NotFound";

export function App() {
  const location = useQuery(locationState.get(LOCATION_ID));
  const route = parseRoute(location?.path ?? "/");

  return (
    <>
      <div className="top-right">
        <NameControl />
      </div>
      {route.page === "home" && <Home />}
      {/* Keyed, so that moving from one game to another starts a fresh page. */}
      {route.page === "game" && <GamePage key={route.gameId} gameId={route.gameId} />}
      {route.page === "notFound" && <NotFound />}
    </>
  );
}
