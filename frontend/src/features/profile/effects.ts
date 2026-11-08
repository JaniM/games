import { effect } from "millpond";
import { apiFetch, sessionState } from "../session";
import { nameSaveFailed, nameSaved, profileLoadFailed, profileLoaded, profileLoading } from "./ops";
import { meSchema } from "./schemas";
import { profileState } from "./tables";

/**
 * Fetches the user's name whenever the session becomes ready: at startup, and
 * again after the session registers a new user. This is also the first
 * authenticated call of a visit, so a stored token the server has forgotten is
 * found out here (`apiFetch` answers a 401 by registering a new user, and this
 * task then restarts with it).
 */
export const loadProfile = effect({
  inputs: [sessionState],
  watch: (q, task) =>
    q.each(sessionState.byState.stateEq("ready"), () =>
      task(
        async (ctx) => {
          ctx.run(profileLoading, undefined);
          try {
            const res = await apiFetch(ctx, "/api/me", { signal: ctx.signal });
            if (res.status === 401) return;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            ctx.run(profileLoaded, { name: meSchema.parse(await res.json()).name });
          } catch (err) {
            // An aborted task (restarted or disposed) can't write, and shouldn't try.
            if (!ctx.signal.aborted) ctx.run(profileLoadFailed, { error: String(err) });
          }
        },
        { label: "GET /api/me" },
      ),
    ),
});

/**
 * Sends the name while the profile is `saving`. It is nested in the ready session,
 * so a save that meets a 401 stays `saving` and is sent again once the session
 * has a new token.
 */
export const saveName = effect({
  inputs: [sessionState, profileState],
  watch: (q, task) =>
    q.each(sessionState.byState.stateEq("ready"), () =>
      q.each(profileState.byState.stateEq("saving"), (profile) =>
        task(
          async (ctx) => {
            try {
              const res = await apiFetch(ctx, "/api/me", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: profile.pending }),
                signal: ctx.signal,
              });
              if (res.status === 401) return;
              if (!res.ok) {
                // 422 carries the reason, in words meant for the user.
                throw new Error(res.status === 422 ? await res.text() : `HTTP ${res.status}`);
              }
              ctx.run(nameSaved, { name: meSchema.parse(await res.json()).name });
            } catch (err) {
              if (!ctx.signal.aborted) ctx.run(nameSaveFailed, { error: String(err) });
            }
          },
          { label: "PATCH /api/me" },
        ),
      ),
    ),
});
