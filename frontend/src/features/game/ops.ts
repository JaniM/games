import { type Tx, op } from "millpond";
import { SESSION_ID, sessionState } from "../session";
import type { Action, Snapshot, Step } from "./schemas";
import { landing, seatOf } from "./selectors";
import { gameActions, gameViews, joinRequests } from "./tables";

/** Marks a game page as open. The `connectGame` effect then connects. Does nothing if it is already open. */
export const openGame = op((tx, args: { gameId: string }) => {
  if (tx.read(gameViews.get(args.gameId))) return;
  tx.insert(gameViews, {
    gameId: args.gameId,
    connection: "connecting",
    snapshot: null,
    problem: null,
    error: null,
    busy: false,
    selected: null,
    queued: [],
    auto: false,
  });
});

/** Marks a game page as closed: the socket goes away, and so does anything waiting to be sent. */
export const closeGame = op((tx, args: { gameId: string }) => {
  for (const action of tx.read(gameActions.byGame.gameIdEq(args.gameId))) {
    tx.delete(gameActions, action.id);
  }
  if (tx.read(joinRequests.get(args.gameId))) tx.delete(joinRequests, args.gameId);
  if (tx.read(gameViews.get(args.gameId))) tx.delete(gameViews, args.gameId);
});

/** Records where the game's connection stands. A drop also ends the wait for an answer. */
export const connectionChanged = op(
  (tx, args: { gameId: string; connection: "connecting" | "reconnecting" | "missing" }) => {
    if (!tx.read(gameViews.get(args.gameId))) return;
    tx.update(gameViews, args.gameId, {
      connection: args.connection,
      busy: false,
      selected: null,
      queued: [],
    });
  },
);

/**
 * Takes a snapshot from the server. One older than the one held is ignored: the server
 * numbers changes, and a snapshot that arrives late must not undo a newer one.
 *
 * A snapshot of a newer revision answers any action in flight, so it clears the pending
 * state and the last refusal. The position the selection was made in is gone, so the
 * selection goes too, except that a checker which has just moved stays selected where it
 * landed if the user can play on with it (see `submitAction`).
 *
 * The steps still queued for a combined move (see `submitMoves`) stay queued if the next one
 * can be played in this position, and are dropped if it can't: the position is not the one
 * the move was planned in.
 *
 * One of the same revision is the same position with new labels, because a player changed
 * their name, or the same snapshot again after a reconnect. It replaces the old one and
 * leaves what the player is in the middle of alone.
 */
export const snapshotReceived = op((tx, args: { gameId: string; snapshot: Snapshot }) => {
  const view = tx.read(gameViews.get(args.gameId));
  if (!view) return;
  const held = view.snapshot;
  if (held && args.snapshot.revision < held.revision) return;
  if (held && args.snapshot.revision === held.revision) {
    tx.update(gameViews, args.gameId, { connection: "open", snapshot: args.snapshot, problem: null });
    return;
  }
  const userId = tx.read(sessionState.get(SESSION_ID))?.userId ?? null;
  const [next] = view.queued;
  tx.update(gameViews, args.gameId, {
    connection: "open",
    snapshot: args.snapshot,
    problem: null,
    error: null,
    busy: false,
    selected: startable(args.snapshot, userId, view.selected),
    queued: next && playable(args.snapshot, userId, next) ? view.queued : [],
  });
});

/** `point` if the user may start a step from it in `snapshot`, on their own turn, else null. */
function startable(snapshot: Snapshot | null, userId: string | null, point: number | null) {
  const state = snapshot?.state;
  if (point === null || !snapshot || !state) return null;
  if (seatOf(snapshot, userId) !== state.turn) return null;
  return state.legal.some((step) => step.from === point) ? point : null;
}

/** Whether the user may play `step` now, in `snapshot`: it is their turn and the server lists it. */
function playable(snapshot: Snapshot | null, userId: string | null, step: Step): boolean {
  const state = snapshot?.state;
  if (!snapshot || !state || seatOf(snapshot, userId) !== state.turn) return false;
  return state.legal.some((legal) => legal.from === step.from && legal.die === step.die);
}

/** Records that the game can't be shown, with the reason for the player. */
export const gameProblem = op((tx, args: { gameId: string; problem: string }) => {
  if (!tx.read(gameViews.get(args.gameId))) return;
  tx.update(gameViews, args.gameId, { problem: args.problem, busy: false });
});

/**
 * Records the server's answer to an action it did not accept. That ends auto-play: it plays
 * only what the server listed as legal, so a refusal means something is wrong, and carrying
 * on would only ask again.
 */
export const actionRefused = op((tx, args: { gameId: string; message: string }) => {
  if (!tx.read(gameViews.get(args.gameId))) return;
  tx.update(gameViews, args.gameId, {
    error: args.message,
    busy: false,
    selected: null,
    queued: [],
    auto: false,
  });
});

/**
 * Turns auto-play on or off for a game. Only a player can turn it on: a spectator has no
 * turns to play.
 */
export const setAutoplay = op((tx, args: { gameId: string; on: boolean }) => {
  const view = tx.read(gameViews.get(args.gameId));
  if (!view || view.auto === args.on) return;
  const userId = tx.read(sessionState.get(SESSION_ID))?.userId ?? null;
  if (args.on && (!view.snapshot || seatOf(view.snapshot, userId) === null)) return;
  tx.update(gameViews, args.gameId, { auto: args.on });
});

/**
 * Selects the point whose checker the player wants to move, or clears the selection
 * with `null`. Selecting the selected point clears it. Only a point the server lists
 * as a start of a legal step, on the user's own turn, can be selected.
 */
export const selectPoint = op((tx, args: { gameId: string; point: number | null }) => {
  const view = tx.read(gameViews.get(args.gameId));
  if (!view) return;
  if (args.point === null || args.point === view.selected) {
    if (view.selected !== null) tx.update(gameViews, args.gameId, { selected: null });
    return;
  }
  const userId = tx.read(sessionState.get(SESSION_ID))?.userId ?? null;
  if (view.busy || view.queued.length > 0) return;
  if (startable(view.snapshot, userId, args.point) === null) return;
  tx.update(gameViews, args.gameId, { selected: args.point });
});

/**
 * Asks the `sendActions` effect to send an action on the game's socket. Ignored unless
 * the connection is open, no earlier action is waiting for its answer, and no combined move
 * is half played (see `submitMoves`). Whether the action is allowed is the server's call.
 *
 * A move of the selected checker that lands on a point selects that point, so that the next
 * die can be played with the same checker without picking it again. Nothing shows the
 * selection while the action is in flight, and the snapshot that answers it keeps the
 * selection only if the checker can move again (`snapshotReceived`). Any other action
 * clears the selection, which is how auto-play (which selects nothing) leaves none.
 */
export const submitAction = op((tx, args: { gameId: string; action: Action }) => {
  const view = tx.read(gameViews.get(args.gameId));
  if (view?.connection !== "open" || view.busy || view.queued.length > 0) return;
  const { action } = args;
  const to = action.type === "move" && action.from === view.selected ? landing(action) : "off";
  send(tx, args.gameId, action, to === "off" ? null : to, []);
});

/** Queues `action` to go out, and waits for its answer. `queued` are the steps to send after it. */
function send(tx: Tx, gameId: string, action: Action, selected: number | null, queued: Step[]) {
  tx.insert(gameActions, { gameId, action });
  tx.update(gameViews, gameId, { busy: true, error: null, selected, queued });
}

/**
 * Plays `steps` as one move by the user: several dice with one checker, one after the other
 * (a combined move, which the server lists in `combos`), or a single step. The server knows
 * only steps, so the first goes out now, as a `move` action, and the rest wait in the view's
 * `queued` until the answer to the one before arrives (`continueMoves` sends them, `sendQueued`
 * is the op). The other player sees each step happen, as in a turn played one click at a time.
 *
 * Nothing else can be started while steps are queued: the selection is cleared and presses are
 * ignored (`selectPoint`, `submitAction`). The position the move was planned in may change in
 * between, and then the rest is dropped (`snapshotReceived`, `sendQueued`). The checker ends up
 * selected where the last step lands, if it can go on (as after `submitAction`).
 */
export const submitMoves = op((tx, args: { gameId: string; steps: Step[] }) => {
  const view = tx.read(gameViews.get(args.gameId));
  if (view?.connection !== "open" || view.busy || view.queued.length > 0) return;
  const [first, ...rest] = args.steps;
  if (!first) return;
  const to = rest.length === 0 && first.from === view.selected ? landing(first) : "off";
  send(tx, args.gameId, { type: "move", ...first }, to === "off" ? null : to, rest);
});

/**
 * Sends the next queued step of a combined move, if the position is still the one it was
 * planned in: it is the user's turn, nothing is in flight and the server lists the step. If
 * it isn't (another tab played, the game ended), what is left is dropped instead of sent,
 * since the server would only refuse it.
 */
export const sendQueued = op((tx, args: { gameId: string }) => {
  const view = tx.read(gameViews.get(args.gameId));
  const [next, ...rest] = view?.queued ?? [];
  if (!view || !next || view.connection !== "open" || view.busy) return;
  const userId = tx.read(sessionState.get(SESSION_ID))?.userId ?? null;
  if (!playable(view.snapshot, userId, next)) {
    tx.update(gameViews, args.gameId, { queued: [] });
    return;
  }
  const to = rest.length === 0 ? landing(next) : "off";
  send(tx, args.gameId, { type: "move", ...next }, to === "off" ? null : to, rest);
});

/** Records that an action went out. The answer comes as a snapshot or an error. */
export const actionSent = op((tx, args: { id: string }) => {
  if (tx.read(gameActions.get(args.id))) tx.delete(gameActions, args.id);
});

/** Records that an action could not go out, because the socket was not open. */
export const actionDropped = op((tx, args: { id: string; gameId: string }) => {
  if (tx.read(gameActions.get(args.id))) tx.delete(gameActions, args.id);
  if (!tx.read(gameViews.get(args.gameId))) return;
  tx.update(gameViews, args.gameId, {
    busy: false,
    selected: null,
    queued: [],
    error: "The connection was lost before that could be sent. Try again.",
  });
});

/** Asks the `joinGame` effect to take the free seat. Ignored while a request is already running. */
export const joinGame = op((tx, args: { gameId: string }) => {
  if (tx.read(joinRequests.get(args.gameId))?.state === "joining") return;
  tx.upsert(joinRequests, { gameId: args.gameId, state: "joining", error: null });
});

/** Records a finished join. The seat itself arrives in the next snapshot. */
export const joined = op((tx, args: { gameId: string }) => {
  if (tx.read(joinRequests.get(args.gameId))) tx.delete(joinRequests, args.gameId);
});

/** Records a join that did not work. */
export const joinFailed = op((tx, args: { gameId: string; error: string }) => {
  if (!tx.read(joinRequests.get(args.gameId))) return;
  tx.update(joinRequests, args.gameId, { state: "failed", error: args.error });
});
