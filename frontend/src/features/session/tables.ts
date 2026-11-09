import { table } from "millpond";
import { z } from "zod";

/** The singleton key of the one `sessionState` row. */
export const SESSION_ID = "current";

/**
 * Who this browser is on the server. A single row whose `state` is the request
 * an effect picks up, so loading and failure are ordinary data the UI can query:
 *
 * - `registering`: the `register` effect is creating a new guest, or taking up the credentials
 *   another tab saved.
 * - `ready`: the credentials are in use. Stored ones are trusted until the server
 *   answers 401 to them (see `apiFetch`), which goes back to `registering`.
 * - `failed`: registering didn't work.
 *
 * `ready` rows carry `userId` and `accessToken`. A user is a guest until they make an account
 * (see the `account` feature), and then has a `username`.
 */
export const sessionState = table(
  z.object({
    id: z.string(),
    state: z.enum(["registering", "ready", "failed"]),
    userId: z.string().nullable(),
    accessToken: z.string().nullable(),
    /** The name the user signs in with: null for a guest. */
    username: z.string().nullable(),
    /** Why registration failed, or null. */
    error: z.string().nullable(),
    /**
     * The token the server last refused, while `registering` because of it, or null. Credentials
     * another tab has saved are used unless they are this very token (see the `register` effect).
     */
    rejected: z.string().nullable(),
  }),
  { key: "id", indexes: { byState: ["state"] } },
);

/**
 * What else is known about the session, apart from the credentials. A row of its own, because
 * every effect that sends the token restarts when the session row changes: these change without
 * the token doing so, and must not restart anything. Absent until the session starts.
 */
export const sessionFlags = table(
  z.object({
    id: z.string(),
    /**
     * The guest is turning into an account, and the server is about to retire the token the
     * session holds. A 401 for it in the meantime is not news (`tokenRejected` ignores it): the
     * answer that brings the new token is on its way.
     */
    upgrading: z.boolean(),
    /**
     * The username of an account whose session ended without the user asking (it expired, or
     * was ended elsewhere), until they sign in again or let it go. The page tells them. Null
     * otherwise.
     */
    signedOutAs: z.string().nullable(),
  }),
  { key: "id" },
);
