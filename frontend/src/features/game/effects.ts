import { effect } from "millpond";
import type { TaskContext } from "millpond";
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
  snapshotReceived,
  submitAction,
} from "./ops";
import {
  KIND,
  STATE_VERSION,
  errorMessageSchema,
  incomingSnapshotSchema,
  seatReplySchema,
  stateSchema,
} from "./schemas";
import { registerSocket, socketOf, unregisterSocket } from "./sockets";
import { gameActions, gameViews, joinRequests } from "./tables";

const NEWER_VERSION = "This game needs a newer version of the site. Reload the page to get it.";
const OTHER_GAME = "This link is for a different kind of game than this page can show.";

/** What the server's `error` message means to a player, when its own text isn't meant for them. */
const ERROR_TEXT: Record<string, string> = {
  "not-started": "The game is waiting for another player.",
  "not-a-player": "You are watching this game, not playing it.",
};
const GENERIC_ERROR = "Something went wrong on the server. Try again.";

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
  const { revision, stateVersion, players, playerNames, state } = incoming.data;
  const parsed = state === null ? { success: true as const, data: null } : stateSchema.safeParse(state);
  if (stateVersion !== STATE_VERSION || !parsed.success) {
    ctx.run(gameProblem, { gameId, problem: NEWER_VERSION });
    return false;
  }
  ctx.run(snapshotReceived, {
    gameId,
    snapshot: { revision, players, playerNames, state: parsed.data },
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
              if (res.status === 404) throw new Error("This game does not exist any more.");
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
