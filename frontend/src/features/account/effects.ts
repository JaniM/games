import { type TaskContext, effect } from "millpond";
import { pushPath } from "../router";
import {
  SESSION_ID,
  apiFetch,
  clearCredentials,
  credentialsSchema,
  saveCredentials,
  sessionState,
  tokenRejected,
} from "../session";
import { accountCreated, accountFailed, accountLeft, accountSignedIn } from "./ops";
import { accountRequest } from "./tables";

const JSON_HEADERS = { "Content-Type": "application/json" };
const NETWORK = "Could not reach the server. Try again.";

/**
 * Makes the request while it is `submitting`: creates the account, signs in, deletes the user, or
 * signs out. Unlike the effects that nest in the ready session, it isn't stopped by a change to
 * the session: the answer to these is what changes it, and the request must not be made twice.
 */
export const submitAccount = effect({
  inputs: [sessionState, accountRequest],
  watch: (q, task) =>
    q.each(accountRequest.byState.stateEq("submitting"), (row) =>
      task(
        async (ctx) => {
          try {
            if (row.form === "create") await create(ctx, row.username, row.password ?? "");
            else if (row.form === "signIn") await signIn(ctx, row.username, row.password ?? "");
            else if (row.form === "delete") await deleteUser(ctx, row.password);
            else await signOutHere(ctx);
          } catch (err) {
            // An aborted task (restarted or disposed) can't write, and shouldn't try.
            if (ctx.signal.aborted) return;
            console.warn("an account request failed", err);
            ctx.run(accountFailed, { error: NETWORK });
          }
        },
        { label: `account: ${row.form}` },
      ),
    ),
});


async function create(ctx: TaskContext, username: string, password: string) {
  const token = ctx.db.read(sessionState.get(SESSION_ID))?.accessToken;
  const res = await apiFetch(ctx, "/api/account", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ username, password }),
    signal: ctx.signal,
  });
  if (res.ok) {
    const credentials = credentialsSchema.parse(await res.json());
    // Before recording them, so that the next visit finds them even if this one ends here.
    saveCredentials(credentials);
    ctx.run(accountCreated, credentials);
    return;
  }
  ctx.run(accountFailed, { error: await failure(res, "create") });
  // The 401 that `apiFetch` reported was ignored while the guest was upgrading: if the guest
  // token really is gone, say so now that the guest is no longer upgrading.
  if (res.status === 401 && token) ctx.run(tokenRejected, { accessToken: token });
}

async function signIn(ctx: TaskContext, username: string, password: string) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ username, password }),
    signal: ctx.signal,
  });
  if (!res.ok) {
    ctx.run(accountFailed, { error: await failure(res, "signIn") });
    return;
  }
  const credentials = credentialsSchema.parse(await res.json());
  saveCredentials(credentials);
  goToFrontPage();
  ctx.run(accountSignedIn, credentials);
}

async function deleteUser(ctx: TaskContext, password: string | null) {
  const res = await apiFetch(ctx, "/api/me", {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify(password === null ? {} : { password }),
    signal: ctx.signal,
  });
  if (!res.ok) {
    ctx.run(accountFailed, { error: await failure(res, "delete") });
    return;
  }
  clearCredentials();
  goToFrontPage();
  ctx.run(accountLeft, undefined);
}

/**
 * Ends the session on the server so that its token is no good to anyone who has a copy, then
 * forgets it here. If the server can't be reached the user is signed out here all the same: the
 * session lapses by itself after a month of not being used.
 */
async function signOutHere(ctx: TaskContext) {
  const token = ctx.db.read(sessionState.get(SESSION_ID))?.accessToken;
  if (token) {
    try {
      await fetch("/api/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: ctx.signal,
      });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
    }
  }
  clearCredentials();
  goToFrontPage();
  ctx.run(accountLeft, undefined);
}

/** The address bar goes to the front page, if it isn't there. The router's row follows in the op. */
function goToFrontPage() {
  if (location.pathname !== "/") pushPath("/");
}

type Form = "create" | "signIn" | "delete";

/** What a refused request means to the user, in a sentence. */
async function failure(res: Response, form: Form): Promise<string> {
  switch (res.status) {
    case 401:
      return form === "signIn" ? "Wrong username or password." : "Your session had ended. Try again.";
    case 429:
      return `Too many attempts. Try again ${waitText(res.headers.get("Retry-After"))}.`;
    case 403:
    case 409:
    case 422:
      return sentence(await res.text());
    default:
      return "Something went wrong on the server. Try again.";
  }
}

/** "in 10 minutes", from a `Retry-After` in seconds; "later" if it isn't one. */
export function waitText(retryAfter: string | null): string {
  const seconds = Number(retryAfter);
  if (!retryAfter || !Number.isFinite(seconds) || seconds <= 0) return "later";
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** The server's reason as a sentence: "that username is taken" becomes "That username is taken." */
export function sentence(reason: string): string {
  const text = reason.trim();
  if (!text) return "Something went wrong on the server. Try again.";
  const capitalised = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}
