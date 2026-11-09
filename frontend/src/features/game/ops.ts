import { type Tx, op } from "millpond";
import { SESSION_ID, sessionState } from "../session";
import { atFor, extend, framesOf, reviewAlwaysOn, shownIndex } from "./review";
import type { Action, Frame, Snapshot, Step } from "./schemas";
import { landing, seatOf } from "./selectors";
import { gameActions, gameViews, joinRequests, rematchRequests, reviews } from "./tables";

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
    rematchStarted: null,
  });
});

/** Marks a game page as closed: the socket goes away, and so does anything waiting to be sent. */
export const closeGame = op((tx, args: { gameId: string }) => {
  for (const action of tx.read(gameActions.byGame.gameIdEq(args.gameId))) {
    tx.delete(gameActions, action.id);
  }
  if (tx.read(joinRequests.get(args.gameId))) tx.delete(joinRequests, args.gameId);
  if (tx.read(rematchRequests.get(args.gameId))) tx.delete(rematchRequests, args.gameId);
  if (tx.read(reviews.get(args.gameId))) tx.delete(reviews, args.gameId);
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
 * A player who sees the rematch start moves on to it (`rematchStarted`). That is only for a
 * player, and only for the snapshot in which it starts, after others the page held: a rematch
 * that was already going when the page opened is there to follow, not to be taken to. A
 * snapshot also ends a failure to answer about the rematch, which was about the one before.
 *
 * A game that is in review gets the position of a newer snapshot as one more frame (see
 * `followReview`).
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
  const rematch = args.snapshot.rematch;
  const started =
    held && held.rematch?.type !== "accepted" && rematch?.type === "accepted" && seatOf(args.snapshot, userId) !== null
      ? rematch.gameId
      : null;
  if (tx.read(rematchRequests.get(args.gameId))?.state === "failed") {
    tx.delete(rematchRequests, args.gameId);
  }
  followReview(tx, args.gameId, args.snapshot);
  tx.update(gameViews, args.gameId, {
    connection: "open",
    snapshot: args.snapshot,
    problem: null,
    error: null,
    busy: false,
    selected: startable(args.snapshot, userId, view.selected),
    queued: next && playable(args.snapshot, userId, next) ? view.queued : [],
    rematchStarted: started ?? view.rematchStarted,
  });
});

/**
 * Adds the position of a new snapshot to the game's review, if there is one that is up to date.
 * If positions were missed in between, the review asks the server for them all again; the frames
 * it holds stay on show until the answer. A review that is still loading, or has failed,
 * doesn't take part: its next answer starts from the snapshot the page holds (`reviewLoaded`).
 */
function followReview(tx: Tx, gameId: string, snapshot: Snapshot) {
  const review = tx.read(reviews.get(gameId));
  if (review?.load !== "ready") return;
  const more = extend(review.frames, review.through, snapshot);
  if (more.type === "frames") {
    tx.update(reviews, gameId, { frames: more.frames, through: more.through });
  } else if (more.type === "missed") {
    tx.update(reviews, gameId, { load: "loading" });
  }
}

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

/**
 * Gives up the game (D10): sends the forfeit and waits for the answer, which is the snapshot
 * of the finished game. Ignored unless the user is a player in a game that is on, the
 * connection is open and no action is waiting for its answer. Unlike a move it doesn't wait for
 * the user's turn, and it ends a combined move that is half played: what is still queued is
 * dropped, since the game will be over.
 */
export const forfeitGame = op((tx, args: { gameId: string }) => {
  const view = tx.read(gameViews.get(args.gameId));
  if (view?.connection !== "open" || view.busy) return;
  const state = view.snapshot?.state;
  const userId = tx.read(sessionState.get(SESSION_ID))?.userId ?? null;
  if (!view.snapshot || !state || state.phase.type === "over") return;
  if (seatOf(view.snapshot, userId) === null) return;
  send(tx, args.gameId, { type: "forfeit" }, null, []);
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

/**
 * Asks the `rematchRequest` effect to ask for a rematch of the finished game: or, if the
 * other player has asked already, to say yes. Ignored while a request for this game is on its
 * way, so that pressing twice asks once. The server decides whether it is allowed.
 */
export const askRematch = op((tx, args: { gameId: string }) => {
  if (tx.read(rematchRequests.get(args.gameId))?.state === "sending") return;
  tx.upsert(rematchRequests, { gameId: args.gameId, answer: "ask", state: "sending", error: null });
});

/**
 * Asks the `rematchRequest` effect to take back the player's own ask for a rematch, or to say
 * no to the other player's. Ignored while a request for this game is on its way.
 */
export const declineRematch = op((tx, args: { gameId: string }) => {
  if (tx.read(rematchRequests.get(args.gameId))?.state === "sending") return;
  tx.upsert(rematchRequests, { gameId: args.gameId, answer: "decline", state: "sending", error: null });
});

/** Records an answer the server took. What it did arrives in the next snapshot. */
export const rematchSent = op((tx, args: { gameId: string }) => {
  if (tx.read(rematchRequests.get(args.gameId))) tx.delete(rematchRequests, args.gameId);
});

/** Records an answer that did not work, with the reason for the player. */
export const rematchFailed = op((tx, args: { gameId: string; error: string }) => {
  if (!tx.read(rematchRequests.get(args.gameId))) return;
  tx.update(rematchRequests, args.gameId, { state: "failed", error: args.error });
});

/**
 * Starts stepping through the game's positions: the `loadReview` effect asks the server for
 * them. The review opens on the newest, so the board stays as it is until the user steps back.
 * Ignored if the page is already reviewing, or has no game to review yet.
 */
export const openReview = op((tx, args: { gameId: string }) => {
  if (!tx.read(gameViews.get(args.gameId))?.snapshot?.state) return;
  if (tx.read(reviews.get(args.gameId))) return;
  tx.insert(reviews, { gameId: args.gameId, load: "loading", error: null, frames: [], through: -1, at: null });
});

/**
 * Opens the review of a game that always has one (see `reviewAlwaysOn`), if it isn't open. Any
 * other game is left as it is. The page calls it whenever the game or the user changes, so a
 * game that has just ended, or has just had its first move, gets its review, and a watcher gets
 * one as soon as the game is there. `userId` is who is looking, null while that isn't known.
 */
export const keepReview = op((tx, args: { gameId: string; userId: string | null }) => {
  const snapshot = tx.read(gameViews.get(args.gameId))?.snapshot;
  if (snapshot && reviewAlwaysOn(snapshot, args.userId)) tx.run(openReview, { gameId: args.gameId });
});

/** Ends the review: the board goes back to the game as it is now. */
export const closeReview = op((tx, args: { gameId: string }) => {
  if (tx.read(reviews.get(args.gameId))) tx.delete(reviews, args.gameId);
});

/**
 * Takes the positions the server kept. They are the frames of the review, and the snapshot the
 * page holds is added to them if it is newer, since it may have come while the answer was on its
 * way. If it is more than one position ahead, the server is asked again, but only as long as each
 * answer got further than the one before: an answer that doesn't is all the server has.
 */
export const reviewLoaded = op((tx, args: { gameId: string; positions: Frame[] }) => {
  const review = tx.read(reviews.get(args.gameId));
  if (review?.load !== "loading") return;
  let frames = framesOf(args.positions);
  let through = args.positions.at(-1)?.revision ?? -1;
  let load: "ready" | "loading" = "ready";
  const snapshot = tx.read(gameViews.get(args.gameId))?.snapshot;
  const more = snapshot ? extend(frames, through, snapshot) : null;
  if (more?.type === "frames") ({ frames, through } = more);
  else if (more?.type === "missed" && through > review.through) load = "loading";
  tx.update(reviews, args.gameId, { load, error: null, frames, through });
});

/** Records that the positions could not be had, with the reason for the player. The frames held stay. */
export const reviewFailed = op((tx, args: { gameId: string; error: string }) => {
  if (tx.read(reviews.get(args.gameId))?.load !== "loading") return;
  tx.update(reviews, args.gameId, { load: "failed", error: args.error });
});

/** Asks again after a failure. */
export const retryReview = op((tx, args: { gameId: string }) => {
  if (tx.read(reviews.get(args.gameId))?.load !== "failed") return;
  tx.update(reviews, args.gameId, { load: "loading", error: null });
});

/** Shows frame `index` of the review. One past either end is the end: the newest follows the game. */
export const showFrame = op((tx, args: { gameId: string; index: number }) => {
  const review = tx.read(reviews.get(args.gameId));
  if (!review || review.frames.length === 0) return;
  const at = atFor(review.frames.length, args.index);
  if (at !== review.at) tx.update(reviews, args.gameId, { at });
});

/** Shows the frame `by` places from the one on show: 1 for the next, -1 for the one before. */
export const stepFrame = op((tx, args: { gameId: string; by: number }) => {
  const review = tx.read(reviews.get(args.gameId));
  const shown = review ? shownIndex(review.frames.length, review.at) : null;
  if (!review || shown === null) return;
  const at = atFor(review.frames.length, shown + args.by);
  if (at !== review.at) tx.update(reviews, args.gameId, { at });
});
