import { op } from "millpond";
import type { Credentials } from "./credentials";
import { SESSION_ID, sessionState } from "./tables";

/**
 * Makes sure the session exists. Call it once at startup with whatever local
 * storage held.
 *
 * - With an access token already in memory, or a registration under way, it does nothing.
 * - With stored credentials, it adopts them. If the server no longer knows them,
 *   the first `apiFetch` finds out and registers a new user.
 * - Otherwise it asks the `register` effect to register a new user. Calling it
 *   again after a failed registration retries.
 */
export const startSession = op((tx, args: { stored: Credentials | null }) => {
  const existing = tx.read(sessionState.get(SESSION_ID));
  if (existing?.accessToken != null || existing?.state === "registering") return;

  if (args.stored) {
    tx.upsert(sessionState, { id: SESSION_ID, state: "ready", error: null, ...args.stored });
  } else {
    tx.upsert(sessionState, {
      id: SESSION_ID,
      state: "registering",
      userId: null,
      accessToken: null,
      error: null,
    });
  }
});

/** Records a finished registration. */
export const registered = op((tx, credentials: Credentials) => {
  tx.update(sessionState, SESSION_ID, { state: "ready", error: null, ...credentials });
});

/** Records a registration that didn't work. */
export const registrationFailed = op((tx, result: { error: string }) => {
  tx.update(sessionState, SESSION_ID, { state: "failed", error: result.error });
});

/**
 * Records that the server answered 401 to `accessToken`: it doesn't know us, so
 * the `register` effect gets a new user. Ignored unless `accessToken` is still the
 * current token. That way several requests that fail together register only once,
 * and a late 401 can't throw away a token we have since replaced.
 */
export const tokenRejected = op((tx, args: { accessToken: string }) => {
  const current = tx.read(sessionState.get(SESSION_ID));
  if (current?.accessToken !== args.accessToken) return;
  tx.update(sessionState, SESSION_ID, {
    state: "registering",
    userId: null,
    accessToken: null,
    error: null,
  });
});
