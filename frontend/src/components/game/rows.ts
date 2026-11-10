import type { RowOf } from "millpond";
import type { gameViews, joinRequests, rematchRequests, reviews } from "../../features/game";

// The rows a game screen is drawn from. A screen gets them as props, so that it can be
// rendered without a db.

/** A game page's row. Its snapshot is of any kind of game: a screen narrows it to its own. */
export type AnyGameViewRow = RowOf<typeof gameViews>;
export type JoinRequestRow = RowOf<typeof joinRequests>;
export type RematchRequestRow = RowOf<typeof rematchRequests>;
export type ReviewRow = RowOf<typeof reviews>;
