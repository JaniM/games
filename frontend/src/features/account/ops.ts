import { type Tx, op } from "millpond";
import { forgetGames } from "../lobby";
import { PROFILE_ID, profileState } from "../profile";
import { pathChanged } from "../router";
import {
  type Credentials,
  SESSION_ID,
  becameGuest,
  sessionState,
  signedIn,
  upgradeFailed,
  upgradeStarted,
} from "../session";
import { ACCOUNT_ID, accountRequest } from "./tables";

/**
 * Opens the form to make an account (as a guest), sign in, or delete the user. Ignored while a
 * request is on its way. Opening one again replaces the form that was open. `username` is what
 * the form starts with: for signing in, the one the user was signed in as. The form to make an
 * account starts with the guest's current name, which will be replaced by the username: it is
 * what they are called now, and the server says if it can't be one (a username has no spaces).
 */
export const openAccountForm = op(
  (tx, args: { form: "create" | "signIn" | "delete"; username?: string }) => {
    if (tx.read(accountRequest.get(ACCOUNT_ID))?.state === "submitting") return;
    // An account can't make another. The server would say so too.
    if (args.form === "create" && tx.read(sessionState.get(SESSION_ID))?.username != null) return;
    const name = args.form === "create" ? tx.read(profileState.get(PROFILE_ID))?.name : null;
    tx.upsert(accountRequest, {
      id: ACCOUNT_ID,
      form: args.form,
      state: "editing",
      username: args.username ?? name ?? "",
      password: null,
      error: null,
    });
  },
);

/** Closes the form. Ignored while the request is on its way. */
export const closeAccountForm = op((tx) => {
  if (tx.read(accountRequest.get(ACCOUNT_ID))?.state === "editing") tx.delete(accountRequest, ACCOUNT_ID);
});

/**
 * Sends what was typed in the open form. The surrounding spaces of a username are dropped (a
 * phone's keyboard adds them), and a form with nothing to send says so without asking the
 * server. Everything else is for the server to judge: it knows the rules. Making an account
 * marks the session as upgrading, so that the guest token the server retires doesn't read as a
 * lost session (see `tokenRejected`).
 */
export const submitAccountForm = op((tx, args: { username: string; password: string }) => {
  const request = tx.read(accountRequest.get(ACCOUNT_ID));
  if (request?.state !== "editing" || request.form === "signOut") return;
  const username = args.username.trim();
  const isAccount = tx.read(sessionState.get(SESSION_ID))?.username != null;
  const needsUsername = request.form !== "delete";
  const needsPassword = request.form !== "delete" || isAccount;
  if ((needsUsername && !username) || (needsPassword && !args.password)) {
    const what = needsUsername ? "a username and a password" : "your password";
    tx.update(accountRequest, ACCOUNT_ID, { error: `Enter ${what}.` });
    return;
  }
  tx.update(accountRequest, ACCOUNT_ID, {
    state: "submitting",
    username,
    password: needsPassword ? args.password : null,
    error: null,
  });
  if (request.form === "create") tx.run(upgradeStarted, undefined);
});

/** Signs out of an account. Ignored for a guest, who has nothing to sign out of. */
export const signOut = op((tx) => {
  if (tx.read(sessionState.get(SESSION_ID))?.username == null) return;
  tx.upsert(accountRequest, {
    id: ACCOUNT_ID,
    form: "signOut",
    state: "submitting",
    username: "",
    password: null,
    error: null,
  });
});

/** Records a request the server refused, or that could not be made, with the reason for the user. */
export const accountFailed = op((tx, args: { error: string }) => {
  const request = tx.read(accountRequest.get(ACCOUNT_ID));
  if (request?.state !== "submitting") return;
  tx.update(accountRequest, ACCOUNT_ID, { state: "editing", password: null, error: args.error });
  if (request.form === "create") tx.run(upgradeFailed, undefined);
});

/** Removes the form or request, if it is still there. */
function finish(tx: Tx) {
  if (tx.read(accountRequest.get(ACCOUNT_ID))) tx.delete(accountRequest, ACCOUNT_ID);
}

/**
 * The guest is an account now: the session is the new one, and the form is gone. It is the same
 * user, so their games are where they were, and so is the page.
 */
export const accountCreated = op((tx, credentials: Credentials) => {
  tx.run(signedIn, credentials);
  finish(tx);
});

/**
 * The user signed in as someone else. The page goes back to the front page, and the games shown
 * are those of the user they are now. (The `submitAccount` effect has moved the address bar.)
 */
export const accountSignedIn = op((tx, credentials: Credentials) => {
  tx.run(signedIn, credentials);
  finish(tx);
  tx.run(forgetGames, undefined);
  tx.run(pathChanged, { path: "/" });
});

/** The user signed out, or deleted themselves: a guest again, on the front page, with no games. */
export const accountLeft = op((tx) => {
  tx.run(becameGuest, undefined);
  finish(tx);
  tx.run(forgetGames, undefined);
  tx.run(pathChanged, { path: "/" });
});
