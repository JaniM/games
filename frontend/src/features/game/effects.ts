import { effect } from "millpond";
import type { TaskContext } from "millpond";
import { gamePath, pathChanged, pushPath } from "../router";
import { SESSION_ID, apiFetch, sessionState, tokenRejected } from "../session";

import {
  CLOSE_NOT_FOUND,
  CLOSE_UNAUTHORIZED,
  SOCKET_OPEN,
  backoffMs,
  socketUrl,
} from "./api";
import { AUTOPLAY_PAUSE_MS, autoplayAction } from "./autoplay";
import {
  actionDropped,
  actionRefused,
  actionSent,
  connectionChanged,
  gameProblem,
  joinFailed,
  joined,
  rematchFailed,
  rematchSent,
  reviewFailed,
  reviewLoaded,
  sendQueued,
  snapshotReceived,
  submitAction,
} from "./ops";
import { asFrame } from "./review";
import {
  type Frame,
  KIND,
  STATE_VERSION,
  errorMessageSchema,
  incomingHistorySchema,
  incomingSnapshotSchema,
  positionSchema,
  seatReplySchema,
  stateSchema,
} from "./schemas";
import { registerSocket, socketOf, unregisterSocket } from "./sockets";
import { gameActions, gameViews, joinRequests, rematchRequests, reviews } from "./tables";

const NEWER_VERSION = "This game needs a newer version of the site. Reload the page to get it.";
const OTHER_GAME = "This link is for a different kind of game than this page can show.";

/** What the server's `error` message means to a player, when its own text isn't meant for them. */
const ERROR_TEXT: Record<string, string> = {
  "not-started": "The game is waiting for another player.",
  "not-a-player": "You are watching this game, not playing it.",
};
const GENERIC_ERROR = "Something went wrong on the server. Try again.";
const GAME_GONE = "This game does not exist any more.";

/**
 * Keeps a WebSocket to every open game, for as long as the game's row exists and the
 * session is ready. Snapshots become ops; when the connection drops the task connects
 * again after a growing pause, until the page is closed (the row goes, the task is
 * aborted and the socket closed).
 *
 * It nests in the ready session, so a new token (after a 401, or a close with
 * `UNAUTHORIZED`, which registers a new user) stops it and starts it again with the
 * new token. `rerunOn: []` keeps its own updates of the row from restarting it.
 */
export const connectGame = effect({
  inputs: [sessionState, gameViews],
  watch: (q, task) =>
    q.each(sessionState.byState.stateEq("ready"), () =>
      q.each(
        gameViews.all(),
        (view) =>
          task(
            async (ctx) => {
              const gameId = view.gameId;
              const token = ctx.db.read(sessionState.get(SESSION_ID))?.accessToken;
              if (token == null) return;

              let failures = 0;
              while (!ctx.signal.aborted) {
                const { code, gotSnapshot } = await connectOnce(ctx, gameId, token);
                if (ctx.signal.aborted) return;

                if (code === CLOSE_UNAUTHORIZED) {
                  ctx.run(tokenRejected, { accessToken: token });
                  return;
                }
                if (code === CLOSE_NOT_FOUND) {
                  ctx.run(connectionChanged, { gameId, connection: "missing" });
                  return;
                }
                // Anything else, including the server shutting the room (1012), is worth another try.
                if (gotSnapshot) failures = 0;
                const pause = backoffMs(failures);
                failures += 1;
                ctx.run(connectionChanged, { gameId, connection: "reconnecting" });
                await sleep(pause, ctx.signal);
                if (ctx.signal.aborted) return;
                ctx.run(connectionChanged, { gameId, connection: "connecting" });
              }
            },
            { label: `WS /api/games/${view.gameId}/ws` },
          ),
        { rerunOn: [] },
      ),
    ),
});

/**
 * One connection: says hello, relays what the server sends into ops, and resolves
 * with the close code when the socket is gone. Aborting the task closes the socket.
 */
function connectOnce(
  ctx: TaskContext,
  gameId: string,
  token: string,
): Promise<{ code: number; gotSnapshot: boolean }> {
  return new Promise((resolve) => {
    let gotSnapshot = false;
    const socket = new WebSocket(socketUrl(gameId));
    registerSocket(gameId, socket);

    const onAbort = () => socket.close();
    const onClose = (event: Event) => {
      ctx.signal.removeEventListener("abort", onAbort);
      unregisterSocket(gameId, socket);
      resolve({ code: (event as CloseEvent).code, gotSnapshot });
    };

    socket.addEventListener("open", () => {
      // The token goes in the first message: a browser can't put it in a header here.
      socket.send(JSON.stringify({ type: "hello", token }));
    });
    socket.addEventListener("message", (event) => {
      if (ctx.signal.aborted) return;
      try {
        if (handleMessage(ctx, gameId, String(event.data))) gotSnapshot = true;
      } catch (err) {
        console.warn("could not handle a message from the game", err);
      }
    });
    // An error always ends in a close, which is where we react.
    socket.addEventListener("close", onClose);

    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Acts on one message from the server. Returns true if it was a usable snapshot. */
function handleMessage(ctx: TaskContext, gameId: string, text: string): boolean {
  const message: unknown = JSON.parse(text);

  const error = errorMessageSchema.safeParse(message);
  if (error.success) {
    const { code, message: reason } = error.data;
    ctx.run(actionRefused, { gameId, message: code === "rejected" ? reason : (ERROR_TEXT[code] ?? GENERIC_ERROR) });
    return false;
  }

  const incoming = incomingSnapshotSchema.safeParse(message);
  if (!incoming.success) {
    // A snapshot we can't read is a problem to show. Any other message is not ours to judge.
    const isSnapshot = typeof message === "object" && message !== null && "type" in message && message.type === "snapshot";
    if (isSnapshot) ctx.run(gameProblem, { gameId, problem: NEWER_VERSION });
    return false;
  }
  if (incoming.data.gameId !== gameId) return false;
  // A game's link doesn't say what game it is, so the server does. State of another game
  // would not fit the board; a game still waiting for a player has no state to show it.
  if (incoming.data.kind !== KIND) {
    ctx.run(gameProblem, { gameId, problem: OTHER_GAME });
    return false;
  }
  const { revision, stateVersion, players, playerNames, state, rematch } = incoming.data;
  const parsed = state === null ? { success: true as const, data: null } : stateSchema.safeParse(state);
  if (stateVersion !== STATE_VERSION || !parsed.success) {
    ctx.run(gameProblem, { gameId, problem: NEWER_VERSION });
    return false;
  }
  ctx.run(snapshotReceived, {
    gameId,
    snapshot: { revision, players, playerNames, state: parsed.data, rematch: rematch ?? null },
  });
  return true;
}

/** Waits `ms`, or less if `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Sends each queued action on its game's socket, and drops it if there is no open socket. */
export const sendActions = effect({
  inputs: [gameActions],
  watch: (q, task) =>
    q.each(gameActions.all(), (row) =>
      task(
        async (ctx) => {
          const socket = socketOf(row.gameId);
          if (socket?.readyState === SOCKET_OPEN) {
            socket.send(JSON.stringify({ type: "action", action: row.action }));
            ctx.run(actionSent, { id: row.id });
          } else {
            ctx.run(actionDropped, { id: row.id, gameId: row.gameId });
          }
        },
        { label: `send ${row.action.type}` },
      ),
    ),
});

/**
 * Plays the user's turns in every game where auto-play is on. Each time the game
 * is waiting for the user, a task pauses (so that the last thing can be followed on the
 * board) and then sends one action: the roll, or one of the legal steps (see `autoplayAction`).
 * The answer is a new snapshot, which starts the next pause.
 *
 * A task is dropped and made again when the switch, the wait for an answer, the connection or
 * the snapshot changes, so it never acts on a game that has moved on or gone quiet. It
 * nests in the ready session for the user's id, as `connectGame` does for the token.
 */
export const autoPlay = effect({
  inputs: [sessionState, gameViews],
  watch: (q, task) =>
    q.each(sessionState.byState.stateEq("ready"), (session) =>
      q.each(
        gameViews.byAuto.autoEq(true),
        (view) => {
          const { snapshot } = view;
          if (view.busy || view.connection !== "open" || !snapshot) return;
          if (!autoplayAction(snapshot, session.userId)) return;
          task(
            async (ctx) => {
              await sleep(AUTOPLAY_PAUSE_MS, ctx.signal);
              if (ctx.signal.aborted) return;
              // The row may have changed in the pause, without this task having been restarted yet.
              const now = ctx.db.read(gameViews.get(view.gameId));
              const action = now?.auto && !now.busy && now.snapshot
                ? autoplayAction(now.snapshot, session.userId)
                : null;
              if (action) ctx.run(submitAction, { gameId: view.gameId, action });
            },
            { label: `auto-play ${view.gameId}` },
          );
        },
        { rerunOn: ["auto", "busy", "connection", "snapshot"] },
      ),
    ),
});

/**
 * How long to wait after the answer to one step of a combined move before sending the next:
 * long enough for the checker to land (`MOVE_MS` in `longBackgammon/cues.ts` is the length of
 * its trip, and `--move-ms` in styles.css), so that each hop can be followed on the board.
 */
export const QUEUED_STEP_PAUSE_MS = 500;

/**
 * Sends the rest of a combined move, one step at a time. Each time a game has steps queued
 * (see `submitMoves`) and is waiting for nothing, a task pauses so that the last hop can be
 * followed, then sends the next step with `sendQueued`, whose answer starts the next pause.
 *
 * A task is dropped and made again when the queue, the wait for an answer or the connection
 * changes, so it never sends into a game that has moved on. `sendQueued` checks the step against
 * the position when it runs, and drops what is left if it no longer fits.
 */
export const continueMoves = effect({
  inputs: [gameViews],
  watch: (q, task) =>
    q.each(
      gameViews.all(),
      (view) => {
        if (view.queued.length === 0 || view.busy || view.connection !== "open") return;
        task(
          async (ctx) => {
            await sleep(QUEUED_STEP_PAUSE_MS, ctx.signal);
            if (ctx.signal.aborted) return;
            ctx.run(sendQueued, { gameId: view.gameId });
          },
          { label: `next step of a move in ${view.gameId}` },
        );
      },
      { rerunOn: ["queued", "busy", "connection"] },
    ),
});

/**
 * Takes the free seat while a join request is `joining`. It nests in the ready session,
 * so a request that meets a 401 stays `joining` and is sent again with the new token.
 */
export const joinGameRequest = effect({
  inputs: [sessionState, joinRequests],
  watch: (q, task) =>
    q.each(sessionState.byState.stateEq("ready"), () =>
      q.each(joinRequests.byState.stateEq("joining"), (request) =>
        task(
          async (ctx) => {
            const { gameId } = request;
            try {
              const res = await apiFetch(ctx, `/api/games/${gameId}/join`, {
                method: "POST",
                signal: ctx.signal,
              });
              if (res.status === 401) return;
              if (res.status === 404) throw new Error(GAME_GONE);
              if (res.status === 409) throw new Error("Both seats are taken.");
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              seatReplySchema.parse(await res.json());
              ctx.run(joined, { gameId });
            } catch (err) {
              if (ctx.signal.aborted) return;
              const error = err instanceof Error ? err.message : String(err);
              ctx.run(joinFailed, { gameId, error });
            }
          },
          { label: `POST /api/games/${request.gameId}/join` },
        ),
      ),
    ),
});

/**
 * Sends the player's answer about the rematch while a request is `sending`: a POST to ask (or
 * say yes), a DELETE to take back an ask (or say no). It nests in the ready session, so a request
 * that meets a 401 stays `sending` and is sent again with the new token. What the answer did
 * comes back to both players as a snapshot, so a request that went through only has to go away.
 */
export const rematchRequest = effect({
  inputs: [sessionState, rematchRequests],
  watch: (q, task) =>
    q.each(sessionState.byState.stateEq("ready"), () =>
      q.each(rematchRequests.byState.stateEq("sending"), (request) => {
        const method = request.answer === "ask" ? "POST" : "DELETE";
        return task(
          async (ctx) => {
            const { gameId } = request;
            try {
              const res = await apiFetch(ctx, `/api/games/${gameId}/rematch`, {
                method,
                signal: ctx.signal,
              });
              if (res.status === 401) return;
              if (res.ok) ctx.run(rematchSent, { gameId });
              else ctx.run(rematchFailed, { gameId, error: rematchErrorText(res.status) });
            } catch {
              // A network failure has no words of its own that a player could use.
              if (!ctx.signal.aborted) ctx.run(rematchFailed, { gameId, error: GENERIC_ERROR });
            }
          },
          { label: `${method} /api/games/${request.gameId}/rematch` },
        );
      }),
    ),
});

/** What the server's refusal of a rematch request means to a player. */
function rematchErrorText(status: number): string {
  switch (status) {
    case 403:
      return "Only the players of this game can do that.";
    case 404:
      return GAME_GONE;
    case 409:
      return "The game is not over yet.";
    default:
      return GENERIC_ERROR;
  }
}

/**
 * Takes the browser to the rematch when a game page sees it start (`rematchStarted`): both
 * players, the one who asked and the one who said yes, end up in the new game without a click.
 * The page that was showing the old game goes away with the move, and with it the view.
 *
 * It runs once for each new rematch: `rerunOn` keeps the snapshots that follow from starting
 * it again.
 */
export const followRematch = effect({
  inputs: [gameViews],
  watch: (q, task) =>
    q.each(
      gameViews.all(),
      (view) => {
        const { rematchStarted } = view;
        if (rematchStarted === null) return;
        task(
          async (ctx) => {
            const path = gamePath(rematchStarted);
            pushPath(path);
            ctx.run(pathChanged, { path });
          },
          { label: `go to the rematch ${rematchStarted}` },
        );
      },
      { rerunOn: ["rematchStarted"] },
    ),
});

/**
 * Asks the server for the positions of a game while its review is `loading`: the first time
 * the review is opened, and again when the snapshots that came in showed that some were missed
 * (see `followReview`). It nests in the ready session, so a request that meets a 401 stays
 * `loading` and is sent again with the new token. A review that asks again because its answer
 * was behind (`reviewLoaded`) moves to a new `through`, which starts a new request.
 */
export const loadReview = effect({
  inputs: [sessionState, reviews],
  watch: (q, task) =>
    q.each(sessionState.byState.stateEq("ready"), () =>
      q.each(
        reviews.byLoad.loadEq("loading"),
        (review) =>
          task(
            async (ctx) => {
              const { gameId } = review;
              try {
                const res = await apiFetch(ctx, `/api/games/${gameId}/history`, {
                  signal: ctx.signal,
                });
                if (res.status === 401) return;
                if (!res.ok) {
                  const error = res.status === 404 ? GAME_GONE : GENERIC_ERROR;
                  ctx.run(reviewFailed, { gameId, error });
                  return;
                }
                const positions = readHistory(gameId, await res.json());
                if (typeof positions === "string") ctx.run(reviewFailed, { gameId, error: positions });
                else ctx.run(reviewLoaded, { gameId, positions });
              } catch {
                // A network failure has no words of its own that a player could use.
                if (!ctx.signal.aborted) ctx.run(reviewFailed, { gameId, error: GENERIC_ERROR });
              }
            },
            { label: `GET /api/games/${review.gameId}/history` },
          ),
        { rerunOn: ["through"] },
      ),
    ),
});

/**
 * The positions in the server answer, as frames. Or, if they cannot be shown, the reason in words
 * for the player: the history is of another kind of game or another layout of the state than this
 * page reads, which is a page that needs reloading, as for a snapshot.
 */
function readHistory(gameId: string, body: unknown): Frame[] | string {
  const history = incomingHistorySchema.safeParse(body);
  if (!history.success || history.data.gameId !== gameId) return GENERIC_ERROR;
  if (history.data.kind !== KIND) return OTHER_GAME;
  if (history.data.stateVersion !== STATE_VERSION) return NEWER_VERSION;
  const frames: Frame[] = [];
  for (const { revision, state } of history.data.positions) {
    const position = positionSchema.safeParse(state);
    if (!position.success) return NEWER_VERSION;
    frames.push(asFrame(revision, position.data));
  }
  return frames;
}
