import { createDb } from "millpond";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GAME_ID,
  marks,
  snapshotMessage,
  startingState,
  utttSnapshotMessage,
  utttState,
  wonBoard,
} from "../../fixtures";
import { FakeWebSocket, fakeServer, fakeStorage, issued, settle } from "../../testing";
import { router } from "../router";
import { session } from "../session";
import { AUTOPLAY_PAUSE_MS } from "./autoplay";
import { game, gameActions, gameViews, reviews } from "./index";
import type { UtttState } from "./schemas";

// An ultimate tic-tac-toe game goes through the same socket, ops and effects as a long backgammon
// one. These are the parts that are about the kind: reading its state, what a player sends, its
// history, and auto-play. (The ops that are about checkers and dice leave it alone.)

const dbs: { dispose(): void }[] = [];
function setup() {
  const server = fakeServer();
  FakeWebSocket.reset();
  vi.stubGlobal("fetch", vi.fn(server.fetchImpl));
  vi.stubGlobal("localStorage", fakeStorage());
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "games.test" });
  vi.stubGlobal("history", { pushState: vi.fn() });
  const db = createDb({ features: { session, game, router } });
  dbs.push(db);
  db.ops.session.startSession({ stored: null });
  return { db, server };
}
type TestDb = ReturnType<typeof setup>["db"];

const view = (db: TestDb) => db.read(gameViews.get(GAME_ID));
const review = (db: TestDb) => db.read(reviews.get(GAME_ID));
const me = issued(1).userId;
const sent = (socket: FakeWebSocket) => socket.sent.filter((m) => m.type !== "hello");

/** Opens the game page and the connection, and lets the server answer with a snapshot. */
async function connected(db: TestDb, message: Record<string, unknown> = {}) {
  db.ops.game.openGame({ gameId: GAME_ID });
  await settle();
  const socket = FakeWebSocket.last;
  socket.open();
  socket.receive(utttSnapshotMessage(message));
  await settle();
  return socket;
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reading a snapshot", () => {
  it("keeps it with its kind, and the state of the game", async () => {
    const { db } = setup();
    const state = utttState({ turn: 1, last: { seat: 0, board: 4, cell: 2 }, cells: marks({ 4: { 2: 0 } }), playable: [2] });

    await connected(db, { revision: 3, state });

    const snapshot = view(db)?.snapshot;
    expect(snapshot?.kind).toBe("ultimate-tic-tac-toe");
    expect(snapshot).toMatchObject({ revision: 3, players: ["user-a", "user-b"], state });
    expect(view(db)).toMatchObject({ connection: "open", problem: null });
  });

  it("keeps a game that is waiting for a player, which has no state yet", async () => {
    const { db } = setup();

    await connected(db, { players: ["u1"], playerNames: ["Ada"], playerGuests: [false], state: null });

    expect(view(db)?.snapshot).toMatchObject({ kind: "ultimate-tic-tac-toe", players: ["u1"], state: null });
  });

  it("is a problem to show when the state is not that of this game, though it says it is", async () => {
    const { db } = setup();

    await connected(db, { state: startingState() });

    expect(view(db)).toMatchObject({ snapshot: null });
    expect(view(db)?.problem).toContain("newer version");
  });

  it("is a problem to show when the state has a layout this client does not read", async () => {
    const { db } = setup();

    await connected(db, { stateVersion: 2 });

    expect(view(db)?.snapshot).toBeNull();
    expect(view(db)?.problem).toContain("newer version");
  });

  it("is a problem to show when a mark is on a board or cell that there is not", async () => {
    const { db } = setup();
    const broken = { ...utttState(), cells: utttState().cells.slice(1) };

    await connected(db, { state: broken });

    expect(view(db)?.snapshot).toBeNull();
    expect(view(db)?.problem).toContain("newer version");
  });

  it("is a game of a kind this site has no board for when the server says another", async () => {
    const { db } = setup();

    await connected(db, { kind: "chess" });

    expect(view(db)?.snapshot).toBeNull();
    expect(view(db)?.problem).toContain("different kind of game");
  });

  it("still reads a long backgammon snapshot as that", async () => {
    const { db } = setup();
    db.ops.game.openGame({ gameId: GAME_ID });
    await settle();
    const socket = FakeWebSocket.last;
    socket.open();

    socket.receive(snapshotMessage());
    await settle();

    expect(view(db)?.snapshot?.kind).toBe("long-backgammon");
  });
});

describe("playing a mark", () => {
  const play = (db: TestDb, board = 4, cell = 2) =>
    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "play", board, cell } });
  const mine = { players: [me, "other"] };

  it("sends it to the server as an action, and waits for the answer", async () => {
    const { db } = setup();
    const socket = await connected(db, mine);

    play(db);
    await settle();

    expect(sent(socket)).toEqual([{ type: "action", action: { type: "play", board: 4, cell: 2 } }]);
    expect(view(db)?.busy).toBe(true);
    expect(db.read(gameActions.all())).toEqual([]);
  });

  it("sends one mark at a time: a second press before the answer is ignored", async () => {
    const { db } = setup();
    const socket = await connected(db, mine);

    play(db);
    play(db, 0, 0);
    await settle();

    expect(sent(socket)).toHaveLength(1);
  });

  it("is over when the next snapshot comes, which also clears what was refused before", async () => {
    const { db } = setup();
    const socket = await connected(db, { ...mine, revision: 1 });
    socket.receive({ type: "error", code: "rejected", message: "not your turn" });
    await settle();
    expect(view(db)?.error).toBe("not your turn");

    play(db);
    await settle();
    socket.receive(
      utttSnapshotMessage({
        ...mine,
        revision: 2,
        state: utttState({ turn: 1, last: { seat: 0, board: 4, cell: 2 }, cells: marks({ 4: { 2: 0 } }), playable: [2] }),
      }),
    );
    await settle();

    expect(view(db)).toMatchObject({ busy: false, error: null });
  });

  it("shows the server's reason when it refuses the mark, and can try again", async () => {
    const { db } = setup();
    const socket = await connected(db, mine);
    play(db);
    await settle();

    socket.receive({ type: "error", code: "rejected", message: "you must play in board 5" });
    await settle();
    expect(view(db)).toMatchObject({ busy: false, error: "you must play in board 5" });

    play(db, 4, 3);
    await settle();
    expect(sent(socket)).toHaveLength(2);
  });

  it("is ignored while the connection is down, so that it is not sent into a position the player has not seen", async () => {
    const { db } = setup();
    const socket = await connected(db, mine);
    socket.serverClose(1006);
    await settle();
    expect(view(db)?.connection).toBe("reconnecting");

    play(db);
    await settle();

    expect(sent(socket)).toEqual([]);
    expect(view(db)).toMatchObject({ busy: false, error: null });
    expect(db.read(gameActions.all())).toEqual([]);
  });

  it("does not select a point: that is for checkers", async () => {
    const { db } = setup();
    await connected(db, mine);

    db.ops.game.selectPoint({ gameId: GAME_ID, point: 4 });

    expect(view(db)?.selected).toBeNull();
  });
});

describe("giving up", () => {
  const forfeit = (db: TestDb) => db.ops.game.forfeitGame({ gameId: GAME_ID });
  const over = (winner: 0 | 1): UtttState =>
    utttState({ phase: { type: "over", winner, forfeited: true }, last: { seat: 0, board: 4, cell: 2 } });

  it("sends the forfeit as a message of its own, on either turn, and waits for the answer", async () => {
    const { db } = setup();
    // Seat 0 is to move; this browser's user is seat 1.
    const socket = await connected(db, { players: ["other", me] });

    forfeit(db);
    await settle();

    expect(sent(socket)).toEqual([{ type: "forfeit" }]);
    expect(view(db)?.busy).toBe(true);
  });

  it("is allowed before the first mark", async () => {
    const { db } = setup();
    const socket = await connected(db, { players: [me, "other"] });

    forfeit(db);
    await settle();

    expect(sent(socket)).toEqual([{ type: "forfeit" }]);
  });

  it("ends with the snapshot of the finished game", async () => {
    const { db } = setup();
    const socket = await connected(db, { players: [me, "other"], revision: 1 });
    forfeit(db);
    await settle();

    socket.receive(utttSnapshotMessage({ players: [me, "other"], revision: 2, state: over(1) }));
    await settle();

    expect(view(db)?.busy).toBe(false);
    expect(view(db)?.snapshot?.state?.phase).toEqual({ type: "over", winner: 1, forfeited: true });
  });

  it("is not sent for a game that is over", async () => {
    const { db } = setup();
    const socket = await connected(db, { players: [me, "other"], state: over(1) });

    forfeit(db);
    await settle();

    expect(sent(socket)).toEqual([]);
    expect(view(db)?.busy).toBe(false);
  });

  it("is not sent by someone who only watches", async () => {
    const { db } = setup();
    const socket = await connected(db, { players: ["a", "b"] });

    forfeit(db);
    await settle();

    expect(sent(socket)).toEqual([]);
    expect(view(db)?.busy).toBe(false);
  });
});

describe("the review of a game", () => {
  /** A position as the server keeps it in the history: the whole state, as it sent it. */
  const kept = (revision: number, state: UtttState) => ({ revision, state });
  const at = (
    cells: Record<number, Record<number, 0 | 1>>,
    last: UtttState["last"],
    turn: 0 | 1,
    playable: number[],
  ) => utttState({ cells: marks(cells), last, turn, playable });
  // The mark in cell 5 sent the next player to board 5; the answer, in cell 1, sent them to board 1.
  const first = at({ 4: { 4: 0 } }, { seat: 0, board: 4, cell: 4 }, 1, [4]);
  const second = at({ 4: { 4: 0, 0: 1 } }, { seat: 1, board: 4, cell: 0 }, 0, [0]);
  const history = [kept(1, utttState()), kept(2, first), kept(3, second)];
  const keep = (server: ReturnType<typeof setup>["server"], positions: unknown[] = history) =>
    server.addGame({
      id: GAME_ID,
      kind: "ultimate-tic-tac-toe",
      players: ["user-a", "user-b"],
      history: positions as { revision: number; state: unknown }[],
    });

  it("is a frame for every position the server kept", async () => {
    const { db, server } = setup();
    keep(server);
    await connected(db, { revision: 3, state: second });

    db.ops.game.openReview({ gameId: GAME_ID });
    await settle();

    const held = review(db);
    expect(held).toMatchObject({ load: "ready", through: 3, at: null });
    expect(held?.frames.map((frame) => frame.revision)).toEqual([1, 2, 3]);
    expect(held?.frames.every((frame) => frame.kind === "ultimate-tic-tac-toe")).toBe(true);
    expect(held?.frames[2]?.state).toMatchObject({ last: { seat: 1, board: 4, cell: 0 } });
  });

  it("keeps in each frame the board that was to be played in then, so that a past position shows it", async () => {
    const { db, server } = setup();
    keep(server);
    await connected(db, { revision: 3, state: second });

    db.ops.game.openReview({ gameId: GAME_ID });
    await settle();

    const played = review(db)?.frames.map((frame) => (frame.kind === "ultimate-tic-tac-toe" ? frame.state.playable : null));
    // Anywhere at the start; then the board each mark sent the next player to.
    expect(played).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8], [4], [0]]);
  });

  it("keeps the boards each position had, which the server worked out", async () => {
    const { db, server } = setup();
    const won = at({ 0: wonBoard(0) }, { seat: 0, board: 0, cell: 2 }, 1, [2]);
    keep(server, [kept(1, utttState()), kept(2, won)]);
    await connected(db, { revision: 2, state: won });

    db.ops.game.openReview({ gameId: GAME_ID });
    await settle();

    const frame = review(db)?.frames.at(-1);
    expect(frame?.kind === "ultimate-tic-tac-toe" && frame.state.boards[0]).toEqual({ type: "won", seat: 0 });
  });

  it("follows the game: a snapshot that comes after is one more frame", async () => {
    const { db, server } = setup();
    keep(server, history.slice(0, 2));
    const socket = await connected(db, { revision: 2, state: first });
    db.ops.game.openReview({ gameId: GAME_ID });
    await settle();

    socket.receive(utttSnapshotMessage({ revision: 3, state: second }));
    await settle();

    expect(review(db)?.frames.map((frame) => frame.revision)).toEqual([1, 2, 3]);
    expect(review(db)).toMatchObject({ through: 3 });
  });

  it("fails as a page that needs reloading when a position is not one this client can read", async () => {
    const { db, server } = setup();
    keep(server, [kept(1, utttState()), { revision: 2, state: { x: 0, cells: "none" } }]);
    await connected(db, { revision: 2, state: first });

    db.ops.game.openReview({ gameId: GAME_ID });
    await settle();

    expect(review(db)).toMatchObject({ load: "failed" });
    expect(review(db)?.error).toContain("newer version");
  });

  it("is always on for a player of a game that is over", async () => {
    const finished = utttState({ ...second, phase: { type: "over", winner: 1, forfeited: false } });
    const { db, server } = setup();
    keep(server);
    await connected(db, { revision: 4, players: ["user-a", me], state: finished });

    db.ops.game.keepReview({ gameId: GAME_ID, userId: me });

    expect(review(db)).toMatchObject({ load: "loading" });
  });

  it("is always on for a user who only watches a game that has been played in", async () => {
    const { db, server } = setup();
    keep(server);
    await connected(db, { revision: 3, players: ["a", "b"], state: second });

    db.ops.game.keepReview({ gameId: GAME_ID, userId: me });

    expect(review(db)).toMatchObject({ load: "loading" });
  });

  it("is left to the players of a game that is on, who open it when they want to look back", async () => {
    const { db, server } = setup();
    keep(server);
    await connected(db, { revision: 3, players: [me, "other"], state: second });

    db.ops.game.keepReview({ gameId: GAME_ID, userId: me });

    expect(review(db)).toBeUndefined();
  });

  it("is not opened for a watcher before a mark has been made", async () => {
    const { db, server } = setup();
    keep(server);
    await connected(db, { revision: 1, players: ["a", "b"], state: utttState() });

    db.ops.game.keepReview({ gameId: GAME_ID, userId: me });

    expect(review(db)).toBeUndefined();
  });
});

describe("auto-play", () => {
  // Fake timers freeze the pauses. `settle` waits on a timer, so these tests flush with `tick`.
  const tick = () => vi.advanceTimersByTimeAsync(0);
  const pause = async (ms = AUTOPLAY_PAUSE_MS) => {
    await vi.advanceTimersByTimeAsync(ms);
    await tick();
  };
  const actionsOf = (socket: FakeWebSocket) =>
    socket.sent.filter((m) => m.type === "action").map((m) => m.action as { type: string; board: number; cell: number });

  /** A game in which this browser's user holds `seat`, with X (seat 0) to move. */
  async function playing(seat: 0 | 1 = 0, state = utttState()) {
    vi.useFakeTimers();
    const ctx = setup();
    await tick();
    await tick(); // the session registers as issued(1), so its user id is user-1
    ctx.db.ops.game.openGame({ gameId: GAME_ID });
    await tick();
    const socket = FakeWebSocket.last;
    socket.open();
    const players = seat === 0 ? [me, "other"] : ["other", me];
    socket.receive(utttSnapshotMessage({ players, state }));
    await tick();
    return { ...ctx, socket, players };
  }

  it("is off when a game opens", async () => {
    const { db, socket } = await playing();

    expect(view(db)?.auto).toBe(false);
    await pause(AUTOPLAY_PAUSE_MS * 5);
    expect(actionsOf(socket)).toEqual([]);
  });

  it("marks a cell for the player after a pause, without selecting anything", async () => {
    const { db, socket } = await playing();

    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause(AUTOPLAY_PAUSE_MS - 1);
    expect(actionsOf(socket)).toEqual([]);
    await pause(1);

    expect(actionsOf(socket)).toHaveLength(1);
    expect(actionsOf(socket)[0]).toMatchObject({ type: "play" });
    expect(view(db)).toMatchObject({ busy: true, selected: null });
  });

  it("plays in the board the player was sent to, and in an empty cell", async () => {
    const state = utttState({
      turn: 1,
      last: { seat: 0, board: 0, cell: 4 },
      cells: marks({ 0: { 4: 0 } }),
      playable: [4],
    });
    const { db, socket } = await playing(1, state);

    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause();

    expect(actionsOf(socket)).toHaveLength(1);
    expect(actionsOf(socket)[0]).toMatchObject({ type: "play", board: 4 });
  });

  it("waits for the answer before playing again, and goes on with the next position", async () => {
    const { db, socket, players } = await playing();
    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause(AUTOPLAY_PAUSE_MS * 6);
    expect(actionsOf(socket)).toHaveLength(1);

    // The opponent answers, and it is the player's turn again.
    const state = utttState({
      turn: 0,
      last: { seat: 1, board: 4, cell: 4 },
      cells: marks({ 0: { 4: 0 }, 4: { 4: 1 } }),
      playable: [4],
    });
    socket.receive(utttSnapshotMessage({ revision: 3, players, state }));
    await tick();
    await pause();

    expect(actionsOf(socket)).toHaveLength(2);
    expect(actionsOf(socket)[1]).toMatchObject({ type: "play", board: 4 });
  });

  it("does nothing while it is the opponent's turn", async () => {
    const { db, socket } = await playing(1); // seat 0 is to move

    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause(AUTOPLAY_PAUSE_MS * 5);

    expect(view(db)?.auto).toBe(true);
    expect(actionsOf(socket)).toEqual([]);
  });

  it("stops when the server refuses what it played", async () => {
    const { db, socket } = await playing();
    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause();

    socket.receive({ type: "error", code: "rejected", message: "that cell is taken" });
    await tick();
    await pause(AUTOPLAY_PAUSE_MS * 5);

    expect(view(db)?.auto).toBe(false);
    expect(actionsOf(socket)).toHaveLength(1);
  });

  it("stops at once when it is switched off", async () => {
    const { db, socket } = await playing();
    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause(AUTOPLAY_PAUSE_MS - 100);

    db.ops.game.setAutoplay({ gameId: GAME_ID, on: false });
    await pause(AUTOPLAY_PAUSE_MS * 3);

    expect(actionsOf(socket)).toEqual([]);
  });

  it("does nothing once the game is over", async () => {
    const over = utttState({ phase: { type: "over", winner: 1, forfeited: false } });
    const { db, socket } = await playing(0, over);

    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause(AUTOPLAY_PAUSE_MS * 3);

    expect(actionsOf(socket)).toEqual([]);
  });
});
