import { useQuery } from "millpond/react";
import { AccountDialogs } from "./components/AccountDialogs";
import { AccountMenu } from "./components/AccountMenu";
import { SiteFooter } from "./components/SiteFooter";
import { SiteNav } from "./components/SiteNav";
import { LOCATION_ID, locationState, parseRoute } from "./features/router";
import { GamePage } from "./pages/GamePage";
import { Home } from "./pages/Home";
import { NotFound } from "./pages/NotFound";
import { Privacy } from "./pages/Privacy";
import { PublicGames } from "./pages/PublicGames";

export function App() {
  const location = useQuery(locationState.get(LOCATION_ID));
  const route = parseRoute(location?.path ?? "/");

  return (
    <>
      {/* The bar along the top stays where it is while the page scrolls under it (see `.site-top`). */}
      <header className="site-top">
        <SiteNav page={route.page === "home" || route.page === "games" ? route.page : "other"} />
        <div className="top-right">
          {/* The sound is for the games: the slider is in the menu while one is open. */}
          <AccountMenu showSound={route.page === "game"} />
        </div>
      </header>
      <AccountDialogs />
      {route.page === "home" && <Home />}
      {route.page === "games" && <PublicGames />}
      {/* Keyed, so that moving from one game to another starts a fresh page. */}
      {route.page === "game" && <GamePage key={route.gameId} gameId={route.gameId} />}
      {route.page === "privacy" && <Privacy />}
      {route.page === "notFound" && <NotFound />}
      {/* Only the front page links to the privacy policy. */}
      {route.page === "home" && <SiteFooter />}
    </>
  );
}
