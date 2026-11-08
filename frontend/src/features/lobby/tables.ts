import { table } from "millpond";
import { z } from "zod";

/** The singleton key of the one `newGame` row. */
export const NEW_GAME_ID = "current";

/**
 * The dialog for creating a game, and the request it makes. No row means no dialog; the
 * dialog is open exactly as long as the row is. `state` says where it stands:
 *
 * - `choosing`: the dialog is open and waiting for the player to confirm.
 * - `creating`: what the `createGameRequest` effect picks up. The dialog can't be dismissed
 *   meanwhile, since the game is made whatever the player does next. A created game deletes
 *   the row (the effect moves the browser to the new game's page).
 * - `failed`: the dialog stays open with `error`, and confirming again tries again.
 */
export const newGame = table(
  z.object({
    id: z.string(),
    state: z.enum(["choosing", "creating", "failed"]),
    kind: z.string(),
    error: z.string().nullable(),
  }),
  { key: "id", indexes: { byState: ["state"] } },
);

/** The singleton key of the one `gamesList` row. */
export const GAMES_LIST_ID = "mine";

/**
 * Whether the user's game list is being read. A single row; `loading` is the request
 * the `loadGamesList` effect picks up. The rows of `myGames` stay while it reloads, so
 * the list doesn't blink.
 */
export const gamesList = table(
  z.object({
    id: z.string(),
    state: z.enum(["loading", "loaded", "failed"]),
    error: z.string().nullable(),
  }),
  { key: "id", indexes: { byState: ["state"] } },
);

/** A game the user has a seat in, as `GET /api/games` lists it. */
export const myGames = table(
  z.object({
    gameId: z.string(),
    kind: z.string(),
    /** The user's seat. */
    seat: z.number().int(),
    /** How many seats are taken. */
    joined: z.number().int(),
    /** False while the game waits for more players. */
    started: z.boolean(),
    /** When the game last changed, in milliseconds since the epoch. */
    updatedAt: z.number(),
  }),
  // Indexing `updatedAt` makes a range query on it (`updatedAtGte(0)` for all of them)
  // come back oldest first, so the page needs no sort of its own: it reverses the result
  // for newest first.
  { key: "gameId", indexes: { byUpdated: ["updatedAt"] } },
);
