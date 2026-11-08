import { effect } from "millpond";
import { gamePath, pathChanged, pushPath } from "../router";
import { apiFetch, sessionState } from "../session";
import { gameCreateFailed, gameCreated, gamesLoadFailed, gamesLoaded } from "./ops";
import { createdReplySchema, gamesReplySchema } from "./schemas";
import { gamesList, newGame } from "./tables";

/**
 * Creates a game while the request is `creating`, then opens its page: the new game's
 * link is the one to share. It nests in the ready session, so a request that meets a
 * 401 stays `creating` and is sent again with the new token.
 */
export const createGameRequest = effect({
  inputs: [sessionState, newGame],
  watch: (q, task) =>
    q.each(sessionState.byState.stateEq("ready"), () =>
      q.each(newGame.byState.stateEq("creating"), (request) =>
        task(
          async (ctx) => {
            try {
              const res = await apiFetch(ctx, "/api/games", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: request.kind, bot: request.bot }),
                signal: ctx.signal,
              });
              if (res.status === 401) return;
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const { gameId } = createdReplySchema.parse(await res.json());
              ctx.run(gameCreated, undefined);
              const path = gamePath(gameId);
              pushPath(path);
              ctx.run(pathChanged, { path });
            } catch (err) {
              // An aborted task (restarted or disposed) can't write, and shouldn't try.
              if (!ctx.signal.aborted) ctx.run(gameCreateFailed, { error: String(err) });
            }
          },
          { label: "POST /api/games" },
        ),
      ),
    ),
});

/** Reads the user's games while the list is `loading`. */
export const loadGamesList = effect({
  inputs: [sessionState, gamesList],
  watch: (q, task) =>
    q.each(sessionState.byState.stateEq("ready"), () =>
      q.each(gamesList.byState.stateEq("loading"), () =>
        task(
          async (ctx) => {
            try {
              const res = await apiFetch(ctx, "/api/games", { signal: ctx.signal });
              if (res.status === 401) return;
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const { games } = gamesReplySchema.parse(await res.json());
              ctx.run(gamesLoaded, { games });
            } catch (err) {
              if (!ctx.signal.aborted) ctx.run(gamesLoadFailed, { error: String(err) });
            }
          },
          { label: "GET /api/games" },
        ),
      ),
    ),
});
