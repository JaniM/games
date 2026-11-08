import { table } from "millpond";
import { z } from "zod";

/** The singleton key of the one `sessionState` row. */
export const SESSION_ID = "current";

/**
 * Who this browser is on the server. A single row whose `state` is the request
 * an effect picks up, so loading and failure are ordinary data the UI can query:
 *
 * - `registering`: the `register` effect is creating a new user.
 * - `ready`: the credentials are in use. Stored ones are trusted until the server
 *   answers 401 to them (see `apiFetch`), which goes back to `registering`.
 * - `failed`: registering didn't work.
 *
 * `ready` rows carry `userId` and `accessToken`.
 */
export const sessionState = table(
  z.object({
    id: z.string(),
    state: z.enum(["registering", "ready", "failed"]),
    userId: z.string().nullable(),
    accessToken: z.string().nullable(),
    /** Why registration failed, or null. */
    error: z.string().nullable(),
  }),
  { key: "id", indexes: { byState: ["state"] } },
);
