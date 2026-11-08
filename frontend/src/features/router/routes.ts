import { GAMES } from "../../games";

/**
 * A page of the site. Starting a game is a dialog on the home page, not a page of its own,
 * so a game kind has no address except the games played in it.
 */
export type Route =
  | { page: "home" }
  /** `/games/<kind>/<gameId>`: play or watch one game. The link is also the invite. */
  | { page: "game"; kind: string; gameId: string }
  | { page: "notFound" };

/** Game ids are random (version 4) uuids. Anything else can't be a game, so it is not asked for. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The page for a `location.pathname`. A single trailing slash is ignored. */
export function parseRoute(pathname: string): Route {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path === "/") return { page: "home" };

  const [empty, section, kind, gameId, ...rest] = path.split("/");
  const known = GAMES.some((game) => game.id === kind);
  if (empty !== "" || section !== "games" || kind === undefined || !known) return { page: "notFound" };
  if (gameId === undefined || rest.length > 0) return { page: "notFound" };
  // Lower case, so that a pasted upper-case id is the same game as the server's.
  return UUID.test(gameId) ? { page: "game", kind, gameId: gameId.toLowerCase() } : { page: "notFound" };
}

/** Where a game lives. The inverse of `parseRoute` for a game page. */
export function gamePath(kind: string, gameId: string): string {
  return `/games/${kind}/${gameId}`;
}
