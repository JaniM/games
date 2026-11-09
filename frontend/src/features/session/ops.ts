import { type Tx, op } from "millpond";
import type { Credentials } from "./credentials";
import { SESSION_ID, sessionFlags, sessionState } from "./tables";

/** The row of a session that is waiting for a new guest: no credentials. */
const noCredentials = {
  userId: null,
  accessToken: null,
  username: null,
} as const;

/** Changes the flags, making the row if there is none yet. Nothing that sends a token notices. */
function setFlags(tx: Tx, patch: { upgrading?: boolean; signedOutAs?: string | null }) {
  const held = tx.read(sessionFlags.get(SESSION_ID)) ?? { id: SESSION_ID, upgrading: false, signedOutAs: null };
  tx.upsert(sessionFlags, { ...held, ...patch });
}

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

  setFlags(tx, { upgrading: false });
  if (args.stored) {
    tx.upsert(sessionState, {
      id: SESSION_ID,
      state: "ready",
      error: null,
      rejected: null,
      ...args.stored,
      username: args.stored.username ?? null,
    });
  } else {
    tx.upsert(sessionState, {
      id: SESSION_ID,
      state: "registering",
      error: null,
      rejected: null,
      ...noCredentials,
    });
  }
});

/**
 * Records credentials the `register` effect got: a new guest's, or the ones another tab of this
 * browser had saved (which can be an account's).
 */
export const registered = op((tx, credentials: Credentials) => {
  tx.update(sessionState, SESSION_ID, {
    state: "ready",
    error: null,
    rejected: null,
    ...credentials,
    username: credentials.username ?? null,
  });
  setFlags(tx, { upgrading: false });
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
 *
 * Also ignored while the guest is becoming an account (`upgrading`): the server retires the
 * guest's token as it makes the account, so requests still using it fail, and the answer that
 * carries the account's session is on its way. Registering a new guest now would throw that
 * session away.
 *
 * If it was an account's session (expired, or ended elsewhere), the username is kept as
 * `signedOutAs`, for the page to say so.
 */
export const tokenRejected = op((tx, args: { accessToken: string }) => {
  const current = tx.read(sessionState.get(SESSION_ID));
  if (current?.accessToken !== args.accessToken) return;
  const flags = tx.read(sessionFlags.get(SESSION_ID));
  if (flags?.upgrading) return;
  tx.update(sessionState, SESSION_ID, {
    state: "registering",
    error: null,
    rejected: args.accessToken,
    ...noCredentials,
  });
  if (current.username !== null) setFlags(tx, { signedOutAs: current.username });
});

/**
 * Makes the credentials of an account the session's: the user signed in, or made an account
 * from a guest. The session stays `ready`, and its row changes, which restarts every effect that
 * sends the token (they are nested in the ready session) with the new one. Works from any state.
 */
export const signedIn = op((tx, credentials: Credentials) => {
  tx.update(sessionState, SESSION_ID, {
    state: "ready",
    error: null,
    rejected: null,
    ...credentials,
    username: credentials.username ?? null,
  });
  setFlags(tx, { upgrading: false, signedOutAs: null });
});

/**
 * The user is a guest again: they signed out or deleted themselves, and the saved credentials
 * are gone. The `register` effect makes a new guest. Nothing is said about it: it was their choice.
 */
export const becameGuest = op((tx) => {
  tx.update(sessionState, SESSION_ID, {
    state: "registering",
    error: null,
    rejected: null,
    ...noCredentials,
  });
  setFlags(tx, { upgrading: false, signedOutAs: null });
});

/** Marks the guest as turning into an account. See `tokenRejected`. Ignored for anyone else. */
export const upgradeStarted = op((tx) => {
  const current = tx.read(sessionState.get(SESSION_ID));
  if (current?.state !== "ready" || current.username !== null) return;
  setFlags(tx, { upgrading: true });
});

/** The account was not made after all: the guest's token is as good as it was. */
export const upgradeFailed = op((tx) => {
  if (tx.read(sessionFlags.get(SESSION_ID))?.upgrading) setFlags(tx, { upgrading: false });
});

/** The user has seen that they were signed out, and doesn't want to sign in again now. */
export const signedOutNoticeDismissed = op((tx) => {
  if (tx.read(sessionFlags.get(SESSION_ID))?.signedOutAs != null) setFlags(tx, { signedOutAs: null });
});
