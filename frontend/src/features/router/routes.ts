import { GAMES } from "../../games";

/**
 * A page of the site. Starting a game is a dialog on the home page, not a page of its own,
 * so a game has no address except the games played.
 */
export type Route =
  | { page: "home" }
  /** `/games`: the public list, which anyone can read. */
  | { page: "games" }
  /** `/games/<gameId>`: play or watch one game. The link is also the invite. */
  | { page: "game"; gameId: string }
  /** `/privacy`: what the site stores about people, and who can see it. */
  | { page: "privacy" }
  | { page: "notFound" };

/**
 * What a game id looks like, so that anything else is not asked for. The server makes them 12
 * characters long (lower case letters and digits). Games from before that have a uuid.
 */
const GAME_ID = /^(?:[0-9a-z]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The page for a `location.pathname`. A single trailing slash is ignored. */
export function parseRoute(pathname: string): Route {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path === "/") return { page: "home" };
  if (path === "/privacy") return { page: "privacy" };
  if (path === "/games") return { page: "games" };

  const [empty, section, first, second, ...rest] = path.split("/");
  if (empty !== "" || section !== "games" || first === undefined || rest.length > 0) {
    return { page: "notFound" };
  }
  // Links used to name the game: `/games/<kind>/<id>`. Those still open the game.
  const named = second !== undefined && GAMES.some((game) => game.id === first);
  const gameId = named ? second : second === undefined ? first : undefined;
  // Lower case, so that a pasted upper-case id is the same game as the server's.
  const id = gameId?.toLowerCase();
  return id !== undefined && GAME_ID.test(id) ? { page: "game", gameId: id } : { page: "notFound" };
}

/** Where a game lives. The inverse of `parseRoute` for a game page. */
export function gamePath(gameId: string): string {
  return `/games/${gameId}`;
}
