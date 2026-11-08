import { table } from "millpond";
import { z } from "zod";
import { actionSchema, snapshotSchema } from "./schemas";

/**
 * A game this browser has open: one row per game page, inserted when the page opens
 * and deleted when it closes. The `connectGame` effect keeps a WebSocket for as long
 * as the row exists, and the page shows whatever the row says.
 *
 * - `connecting`: no snapshot yet on this connection.
 * - `open`: the latest snapshot is current.
 * - `reconnecting`: the connection dropped, and a new one is coming. The old snapshot stays.
 * - `missing`: the server says there is no such game.
 */
export const gameViews = table(
  z.object({
    gameId: z.string(),
    connection: z.enum(["connecting", "open", "reconnecting", "missing"]),
    /** The newest snapshot, or null before the first. */
    snapshot: snapshotSchema.nullable(),
    /** Why the game can't be shown, e.g. a state this client doesn't understand. Null if it can. */
    problem: z.string().nullable(),
    /** The server's reason for refusing the last action, in words for the player. */
    error: z.string().nullable(),
    /** An action is on its way and the server has not answered. */
    busy: z.boolean(),
    /** The point (the mover's own index) whose destinations are showing, or null. */
    selected: z.number().int().nullable(),
  }),
  { key: "gameId" },
);

/**
 * Actions waiting to go out on a game's socket. The `sendActions` effect sends each
 * and the row is gone. Only the open connection can send, so the row never waits
 * across a reconnect: an action meant for an old position must not play in a new one.
 */
export const gameActions = table(
  z.object({ id: z.string(), gameId: z.string(), action: actionSchema }),
  { key: "id", generate: () => crypto.randomUUID(), indexes: { byGame: ["gameId"] } },
);

/**
 * A request to take the free seat in a game. `joining` is what the `joinGame` effect
 * picks up; `failed` keeps the reason. A successful join deletes the row: the seat
 * shows up in the next snapshot, like any other change.
 */
export const joinRequests = table(
  z.object({
    gameId: z.string(),
    state: z.enum(["joining", "failed"]),
    error: z.string().nullable(),
  }),
  { key: "gameId", indexes: { byState: ["state"] } },
);
