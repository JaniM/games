import type { TaskContext } from "millpond";
import { tokenRejected } from "./ops";
import { SESSION_ID, sessionState } from "./tables";

/**
 * `fetch` for endpoints that need a user: sends the session's access token as
 * `Authorization: Bearer <token>`. Use it for every API call except the public
 * ones (`/api/health`, `/api/register`).
 *
 * The server answers 401 only to a token it doesn't know, so a 401 makes the
 * session register a new user. The 401 response is still returned. Have the
 * calling effect watch `sessionState.byState.stateEq("ready")`: it is then
 * stopped during the registration and started again with the new token.
 *
 * Call it from an effect task, passing the task's context. Throws if there is
 * no token yet, which a task that watches `ready` rows never sees.
 */
export async function apiFetch(
  ctx: Pick<TaskContext, "db" | "run">,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const accessToken = ctx.db.read(sessionState.get(SESSION_ID))?.accessToken;
  if (accessToken == null) throw new Error(`cannot call ${path}: no access token yet`);

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) ctx.run(tokenRejected, { accessToken });
  return res;
}
