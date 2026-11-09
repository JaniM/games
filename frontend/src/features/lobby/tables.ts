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
    /** Play against the computer, not a friend who follows a link. */
    bot: z.boolean(),
    /** Put the game in the public list once it has started. */
    public: z.boolean(),
    error: z.string().nullable(),
  }),
  { key: "id", indexes: { byState: ["state"] } },
);

/** The singleton key of the one `lobbySettings` row. */
export const LOBBY_SETTINGS_ID = "current";

/** Whether a new game is public before the player chooses: yes, as the list is for the games. */
export const DEFAULT_PUBLIC = true;

/**
 * What this browser remembers about making games: whether the dialog's "public game" is ticked.
 * A single row, which the `persistLobbySettings` effect keeps in local storage. Before
 * `startLobby` has run there is no row, and the choice is the default.
 */
export const lobbySettings = table(z.object({ id: z.string(), public: z.boolean() }), {
  key: "id",
});

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
    /** True once the game has ended. */
    finished: z.boolean(),
    /** When the game last changed, in milliseconds since the epoch. */
    updatedAt: z.number(),
    /** The names of the players who have joined, by seat; null for one who has no name. */
    playerNames: z.array(z.string().nullable()),
    /** Which of them are guests, by seat: shown with a guest indicator. */
    playerGuests: z.array(z.boolean()),
  }),
  // Indexing `updatedAt` makes a range query on it (`updatedAtGte(0)` for all of them)
  // come back oldest first, so the page needs no sort of its own: it reverses the result
  // for newest first.
  { key: "gameId", indexes: { byUpdated: ["updatedAt"] } },
);

/** The singleton key of the one `publicList` row. */
export const PUBLIC_LIST_ID = "public";

/**
 * Whether the public list is being read. A single row; `loading` is the request the
 * `loadPublicGamesList` effect picks up. The rows of `publicGames` stay while it reloads, so the
 * list doesn't blink.
 */
export const publicList = table(
  z.object({
    id: z.string(),
    state: z.enum(["loading", "loaded", "failed"]),
    error: z.string().nullable(),
  }),
  { key: "id", indexes: { byState: ["state"] } },
);

/**
 * A game in the public list, as `GET /api/public-games` lists it. Every one has started, so a
 * game that isn't `finished` is in progress. Unlike `myGames` there is no seat: the reader may be
 * nobody in the game.
 */
export const publicGames = table(
  z.object({
    gameId: z.string(),
    kind: z.string(),
    /** True once the game has ended. */
    finished: z.boolean(),
    /** When the game last changed, in milliseconds since the epoch. */
    updatedAt: z.number(),
    /** The names of the players, by seat; null for one who has no name. */
    playerNames: z.array(z.string().nullable()),
    /** Which of them are guests, by seat: shown with a guest indicator. */
    playerGuests: z.array(z.boolean()),
  }),
  // As for `myGames`: a range query on `updatedAt` comes back oldest first.
  { key: "gameId", indexes: { byUpdated: ["updatedAt"] } },
);
