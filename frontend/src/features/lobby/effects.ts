import { effect } from "millpond";
import { gamePath, pathChanged, pushPath } from "../router";
import { apiFetch, sessionState } from "../session";
import {
  gameCreateFailed,
  gameCreated,
  gamesLoadFailed,
  gamesLoaded,
  publicGamesLoadFailed,
  publicGamesLoaded,
} from "./ops";
import { createdReplySchema, gamesReplySchema, publicGamesReplySchema } from "./schemas";
import { savePublic } from "./storage";
import { gamesList, lobbySettings, newGame, publicList } from "./tables";

/** Keeps the choice of a public game in local storage, so that the next visit starts as this one ended. */
export const persistLobbySettings = effect({
  inputs: [lobbySettings],
  watch: (q, task) =>
    q.each(lobbySettings.all(), (row) =>
      task(
        async () => {
          savePublic(row.public);
        },
        { label: "save the choice of a public game" },
      ),
    ),
});

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
                body: JSON.stringify({
                  kind: request.kind,
                  bot: request.bot,
                  // The server refuses a level for a game with no bot in it.
                  ...(request.bot ? { level: request.level } : {}),
                  public: request.public,
                }),
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

/**
 * Reads the public list while it is `loading`. The list is for anyone, so it sends no token and
 * waits for no session: it works before the browser is registered, and can't be answered with a
 * 401.
 */
export const loadPublicGamesList = effect({
  inputs: [publicList],
  watch: (q, task) =>
    q.each(publicList.byState.stateEq("loading"), () =>
      task(
        async (ctx) => {
          try {
            const res = await fetch("/api/public-games", { signal: ctx.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const { games } = publicGamesReplySchema.parse(await res.json());
            ctx.run(publicGamesLoaded, { games });
          } catch (err) {
            if (!ctx.signal.aborted) ctx.run(publicGamesLoadFailed, { error: String(err) });
          }
        },
        { label: "GET /api/public-games" },
      ),
    ),
});
