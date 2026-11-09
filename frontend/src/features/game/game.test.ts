import { createDb } from "millpond";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GAME_ID, board, moving, snapshotMessage, startingState } from "../../fixtures";
import { FakeWebSocket, fakeServer, fakeStorage, gameIdOf, issued, settle } from "../../testing";
import { LOCATION_ID, locationState, router } from "../router";
import { SESSION_ID, session, sessionState } from "../session";
import { AUTOPLAY_PAUSE_MS } from "./autoplay";
import { QUEUED_STEP_PAUSE_MS } from "./effects";
import { game, gameActions, gameViews, joinRequests, rematchRequests, reviews } from "./index";

// A fresh db per test, from the same features the app uses.
const dbs: { dispose(): void }[] = [];
function setup() {
  const server = fakeServer();
  const fetchMock = vi.fn(server.fetchImpl);
  const pushState = vi.fn();
  FakeWebSocket.reset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("localStorage", fakeStorage());
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "games.test" });
  vi.stubGlobal("history", { pushState });
  const db = createDb({ features: { session, game, router } });
  dbs.push(db);
  db.ops.session.startSession({ stored: null });
  return { db, server, fetchMock, pushState };
}
type TestDb = ReturnType<typeof setup>["db"];

const view = (db: TestDb, gameId = GAME_ID) => db.read(gameViews.get(gameId));
const sockets = () => FakeWebSocket.instances;

/** Opens the game page and the connection, and lets the server say hello back. */
async function connected(db: TestDb, message: Record<string, unknown> = {}) {
  db.ops.game.openGame({ gameId: GAME_ID });
  await settle();
  const socket = FakeWebSocket.last;
  socket.open();
  socket.receive(snapshotMessage(message));
  await settle();
  return socket;
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("connecting", () => {
  it("waits for the session, then opens the game's socket on the same origin", async () => {
    const { db } = setup();

    db.ops.game.openGame({ gameId: GAME_ID });
    expect(sockets()).toHaveLength(0);
    expect(view(db)).toMatchObject({ connection: "connecting", snapshot: null });

    await settle();
    expect(sockets().map((s) => s.url)).toEqual([`ws://games.test/api/games/${GAME_ID}/ws`]);
  });

  it("uses wss on a secure page", async () => {
    const { db } = setup();
    vi.stubGlobal("location", { protocol: "https:", host: "games.test" });

    db.ops.game.openGame({ gameId: GAME_ID });
    await settle();

    expect(FakeWebSocket.last.url).toBe(`wss://games.test/api/games/${GAME_ID}/ws`);
  });

  it("says hello with the access token before anything else", async () => {
    const { db } = setup();

    db.ops.game.openGame({ gameId: GAME_ID });
    await settle();
    FakeWebSocket.last.open();

    expect(FakeWebSocket.last.sent).toEqual([{ type: "hello", token: issued(1).accessToken }]);
  });

  it("keeps the snapshot the server sends, and is open", async () => {
    const { db } = setup();

    await connected(db, { revision: 4, players: ["u1", "u2"], playerNames: ["Ada", null] });

    expect(view(db)).toMatchObject({
      connection: "open",
      problem: null,
      snapshot: { revision: 4, players: ["u1", "u2"], playerNames: ["Ada", null] },
    });
    expect(view(db)?.snapshot?.state?.phase).toEqual({ type: "roll" });
  });

  it("keeps a waiting game, which has no state yet", async () => {
    const { db } = setup();

    await connected(db, { players: ["u1"], playerNames: [null], state: null });

    expect(view(db)?.snapshot).toMatchObject({ players: ["u1"], state: null });
  });

  it("opens one socket per game page, however many times it is opened", async () => {
    const { db } = setup();

    db.ops.game.openGame({ gameId: GAME_ID });
    db.ops.game.openGame({ gameId: GAME_ID });
    await settle();

    expect(sockets()).toHaveLength(1);
  });

  it("closes the socket when the page closes", async () => {
    const { db } = setup();
    const socket = await connected(db);

    db.ops.game.closeGame({ gameId: GAME_ID });
    await settle();

    expect(socket.readyState).toBe(3);
    expect(view(db)).toBeUndefined();
    expect(sockets()).toHaveLength(1); // and nothing reconnects
  });

  it("closes the socket when the session goes away, and opens another with the new token", async () => {
    const { db } = setup();
    const first = await connected(db);

    db.ops.session.tokenRejected({ accessToken: issued(1).accessToken });
    await settle();

    expect(first.readyState).toBe(3);
    expect(sockets()).toHaveLength(2);
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.sent).toEqual([{ type: "hello", token: issued(2).accessToken }]);
  });
});

describe("who is a guest", () => {
  it("keeps, with each snapshot, which players are guests", async () => {
    const { db } = setup();

    await connected(db, { players: ["u1", "u2"], playerNames: ["Ada", "Grace"], playerGuests: [false, true] });

    expect(view(db)?.snapshot?.playerGuests).toEqual([false, true]);
  });

  it("follows a guest who makes an account: the next snapshot of the same revision says so", async () => {
    const { db } = setup();
    const socket = await connected(db, { revision: 3, playerNames: ["Ada L", "Grace"], playerGuests: [true, true] });

    socket.receive(snapshotMessage({ revision: 3, playerNames: ["ada", "Grace"], playerGuests: [false, true] }));
    await settle();

    expect(view(db)?.snapshot).toMatchObject({ playerNames: ["ada", "Grace"], playerGuests: [false, true] });
  });

  it("is a snapshot this client can't read when a server leaves it out", async () => {
    const { db } = setup();
    const socket = await connected(db);
    const { playerGuests: _left, ...without } = snapshotMessage({ revision: 2 });

    socket.receive(without);
    await settle();

    expect(view(db)?.problem).toContain("newer version");
  });
});

describe("snapshots", () => {
  it("replace each other, newest first", async () => {
    const { db } = setup();
    const socket = await connected(db, { revision: 2 });

    socket.receive(snapshotMessage({ revision: 3, playerNames: ["Ada", "Grace"] }));
    await settle();

    expect(view(db)?.snapshot?.revision).toBe(3);
  });

  it("take a changed name at the same revision", async () => {
    const { db } = setup();
    const socket = await connected(db, { revision: 2, playerNames: ["Ada", null] });

    socket.receive(snapshotMessage({ revision: 2, playerNames: ["Ada", "Grace"] }));
    await settle();

    expect(view(db)?.snapshot).toMatchObject({ revision: 2, playerNames: ["Ada", "Grace"] });
  });

  it("ignore one that arrives after a newer one", async () => {
    const { db } = setup();
    const socket = await connected(db, { revision: 5 });

    socket.receive(snapshotMessage({ revision: 4, players: ["late"] }));
    await settle();

    expect(view(db)?.snapshot).toMatchObject({ revision: 5, players: ["user-a", "user-b"] });
  });

  it("show a problem for a state version this client does not know", async () => {
    const { db } = setup();

    await connected(db, { stateVersion: 2 });

    expect(view(db)?.problem).toMatch(/newer version/);
    expect(view(db)?.snapshot).toBeNull();
  });

  it("show a problem for a state that does not fit, until a good snapshot comes", async () => {
    const { db } = setup();
    const socket = await connected(db, { revision: 1 });

    socket.receive(snapshotMessage({ revision: 2, state: { white: 0 } }));
    await settle();
    expect(view(db)?.problem).toMatch(/newer version/);
    expect(view(db)?.snapshot?.revision).toBe(1);

    socket.receive(snapshotMessage({ revision: 3 }));
    await settle();
    expect(view(db)).toMatchObject({ problem: null, snapshot: { revision: 3 } });
  });

  it("says so when the link is to a kind of game this page can't show, as links do not name it", async () => {
    const { db } = setup();
    db.ops.game.openGame({ gameId: GAME_ID });
    await settle();
    const socket = FakeWebSocket.last;
    socket.open();

    socket.receive(snapshotMessage({ kind: "chess", state: null }));
    await settle();

    expect(view(db)?.problem).toMatch(/different kind of game/);
    expect(view(db)?.snapshot).toBeNull();
  });

  it("ignore a snapshot of another game, and messages of a kind it does not know", async () => {
    const { db } = setup();
    const socket = await connected(db, { revision: 1 });

    socket.receive(snapshotMessage({ gameId: gameIdOf(99), revision: 9 }));
    socket.receive({ type: "something-new" });
    await settle();

    expect(view(db)).toMatchObject({ problem: null, snapshot: { revision: 1 } });
  });
});

describe("a dropped connection", () => {
  // Fake timers freeze the pauses. `settle` waits on a timer, so these tests flush with `tick`.
  const tick = () => vi.advanceTimersByTimeAsync(0);

  async function startedWithFakeTimers() {
    vi.useFakeTimers();
    const ctx = setup();
    ctx.db.ops.game.openGame({ gameId: GAME_ID });
    await tick();
    return ctx;
  }

  it("is retried after a second, keeping the snapshot to look at meanwhile", async () => {
    const { db } = await startedWithFakeTimers();
    FakeWebSocket.last.open();
    FakeWebSocket.last.receive(snapshotMessage());
    await tick();

    FakeWebSocket.last.serverClose(1012);
    await tick();
    expect(view(db)).toMatchObject({ connection: "reconnecting", snapshot: { revision: 1 } });
    expect(sockets()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(sockets()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets()).toHaveLength(2);
    expect(view(db)?.connection).toBe("connecting");

    FakeWebSocket.last.open();
    FakeWebSocket.last.receive(snapshotMessage({ revision: 2 }));
    await tick();
    expect(view(db)).toMatchObject({ connection: "open", snapshot: { revision: 2 } });
  });

  it("is retried with longer pauses while it keeps failing, up to ten seconds", async () => {
    await startedWithFakeTimers();
    const pauses: number[] = [];

    for (let i = 0; i < 6; i++) {
      const before = sockets().length;
      FakeWebSocket.last.serverClose(1006);
      let waited = 0;
      while (sockets().length === before) {
        await vi.advanceTimersByTimeAsync(1);
        waited += 1;
      }
      pauses.push(waited);
    }

    expect(pauses).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
  });

  it("starts the pauses over once a connection has worked", async () => {
    await startedWithFakeTimers();
    FakeWebSocket.last.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.last.serverClose(1006);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets()).toHaveLength(3);

    FakeWebSocket.last.open();
    FakeWebSocket.last.receive(snapshotMessage());
    await tick();
    FakeWebSocket.last.serverClose(1012);
    await vi.advanceTimersByTimeAsync(1000);

    expect(sockets()).toHaveLength(4);
  });

  it("stops being retried when the page closes during the pause", async () => {
    const { db } = await startedWithFakeTimers();
    FakeWebSocket.last.serverClose(1006);
    await tick();

    db.ops.game.closeGame({ gameId: GAME_ID });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sockets()).toHaveLength(1);
  });

  it("forgets an action that was waiting for an answer", async () => {
    const { db } = await startedWithFakeTimers();
    FakeWebSocket.last.open();
    FakeWebSocket.last.receive(snapshotMessage());
    await tick();
    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "roll" } });
    await tick();
    expect(view(db)?.busy).toBe(true);

    FakeWebSocket.last.serverClose(1012);
    await tick();

    expect(view(db)?.busy).toBe(false);
  });
});

describe("a connection the server refuses", () => {
  it("to a game that does not exist is not retried", async () => {
    vi.useFakeTimers();
    const { db } = setup();
    db.ops.game.openGame({ gameId: GAME_ID });
    await vi.advanceTimersByTimeAsync(0);

    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose(4404);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(view(db)?.connection).toBe("missing");
    expect(sockets()).toHaveLength(1);
  });

  it("to a token it does not know registers a new user, and connects as them", async () => {
    const { db, server } = setup();
    db.ops.game.openGame({ gameId: GAME_ID });
    await settle();
    server.users.clear(); // the server has forgotten us

    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose(4401);
    await settle();

    expect(db.read(sessionState.get(SESSION_ID))).toMatchObject({ state: "ready", ...issued(2) });
    expect(sockets()).toHaveLength(2);
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.sent).toEqual([{ type: "hello", token: issued(2).accessToken }]);
  });
});

describe("playing", () => {
  const mover = (extra = {}) => ({
    state: startingState({ ...moving([6, 3], [{ from: 1, die: 6 }, { from: 1, die: 3 }]), ...extra }),
  });

  it("sends an action on the open socket, and waits for the answer", async () => {
    const { db } = setup();
    const socket = await connected(db);

    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "roll" } });
    await settle();

    expect(socket.sent.at(-1)).toEqual({ type: "action", action: { type: "roll" } });
    expect(view(db)?.busy).toBe(true);
    expect(db.read(gameActions.all())).toEqual([]);
  });

  it("sends a move with the checker and the die", async () => {
    const { db } = setup();
    const socket = await connected(db, mover());

    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "move", from: 1, die: 6 } });
    await settle();

    expect(socket.sent.at(-1)).toEqual({ action: { type: "move", from: 1, die: 6 }, type: "action" });
  });

  it("does not send a second action before the first is answered", async () => {
    const { db } = setup();
    const socket = await connected(db);

    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "roll" } });
    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "roll" } });
    await settle();

    expect(socket.sent.filter((m) => m.type === "action")).toHaveLength(1);
  });

  it("is free to act again once a snapshot answers", async () => {
    const { db } = setup();
    const socket = await connected(db);
    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "roll" } });
    await settle();

    socket.receive(snapshotMessage({ revision: 2, ...mover() }));
    await settle();

    expect(view(db)?.busy).toBe(false);
  });

  it("shows the server's reason when it refuses, and clears it with the next action", async () => {
    const { db } = setup();
    const socket = await connected(db);
    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "roll" } });
    await settle();

    socket.receive({ type: "error", code: "rejected", message: "not your turn" });
    await settle();
    expect(view(db)).toMatchObject({ error: "not your turn", busy: false });

    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "roll" } });
    await settle();
    expect(view(db)).toMatchObject({ error: null, busy: true });
  });

  it("clears a refusal when a snapshot arrives", async () => {
    const { db } = setup();
    const socket = await connected(db);
    socket.receive({ type: "error", code: "rejected", message: "not your turn" });
    await settle();

    socket.receive(snapshotMessage({ revision: 2 }));
    await settle();

    expect(view(db)?.error).toBeNull();
  });

  it.each([
    ["not-a-player", /watching/],
    ["not-started", /another player/],
    ["internal", /went wrong/],
    ["bad-message", /went wrong/],
  ])("explains a %s error in its own words", async (code, words) => {
    const { db } = setup();
    const socket = await connected(db);

    socket.receive({ type: "error", code, message: "server wording" });
    await settle();

    expect(view(db)?.error).toMatch(words);
  });

  it("sends nothing while the connection is not open", async () => {
    const { db } = setup();
    db.ops.game.openGame({ gameId: GAME_ID });
    await settle();

    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "roll" } });
    await settle();

    expect(FakeWebSocket.last.sent).toEqual([]);
    expect(db.read(gameActions.all())).toEqual([]);
  });
});

describe("selecting a checker", () => {

  /** A game in which this browser's user holds `seat` and the mover is seat 0. */
  async function playing(seat: 0 | 1) {
    const ctx = setup();
    await settle(); // the session registers as issued(1), so its user id is user-1
    const players = seat === 0 ? [issued(1).userId, "other"] : ["other", issued(1).userId];
    const state = startingState({
      ...moving([6, 3], [{ from: 1, die: 6 }, { from: 1, die: 3 }, { from: 5, die: 3 }]),
    });
    const socket = await connected(ctx.db, { players, state });
    return { ...ctx, socket, players, state };
  }
  const selected = (db: TestDb) => view(db)?.selected;

  it("picks a point the server lists as a start of a step", async () => {
    const { db } = await playing(0);

    db.ops.game.selectPoint({ gameId: GAME_ID, point: 5 });

    expect(selected(db)).toBe(5);
  });

  it("stays selected when a player renames themselves, which is not a move", async () => {
    const { db, socket, players, state } = await playing(0);
    db.ops.game.selectPoint({ gameId: GAME_ID, point: 5 });

    socket.receive(snapshotMessage({ players, state, playerNames: ["Ada", "Gracie"] }));
    await settle();

    expect(view(db)).toMatchObject({
      selected: 5,
      snapshot: { playerNames: ["Ada", "Gracie"] },
    });
  });

  it("is still waiting for the answer to an action when a rename arrives", async () => {
    const { db, socket, players, state } = await playing(0);
    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "move", from: 5, die: 3 } });
    await settle();

    socket.receive(snapshotMessage({ players, state, playerNames: ["Ada", "Gracie"] }));
    await settle();

    expect(view(db)).toMatchObject({ busy: true, snapshot: { playerNames: ["Ada", "Gracie"] } });
  });

  it("clears when the same point is picked again, or with null", async () => {
    const { db } = await playing(0);
    db.ops.game.selectPoint({ gameId: GAME_ID, point: 5 });

    db.ops.game.selectPoint({ gameId: GAME_ID, point: 5 });
    expect(selected(db)).toBeNull();

    db.ops.game.selectPoint({ gameId: GAME_ID, point: 1 });
    db.ops.game.selectPoint({ gameId: GAME_ID, point: null });
    expect(selected(db)).toBeNull();
  });

  it("ignores a point with no legal step", async () => {
    const { db } = await playing(0);

    db.ops.game.selectPoint({ gameId: GAME_ID, point: 9 });

    expect(selected(db)).toBeNull();
  });

  it("ignores the pick of someone who is not the mover", async () => {
    const { db } = await playing(1);

    db.ops.game.selectPoint({ gameId: GAME_ID, point: 1 });

    expect(selected(db)).toBeNull();
  });

  it("is dropped when the position changes", async () => {
    const { db, socket } = await playing(0);
    db.ops.game.selectPoint({ gameId: GAME_ID, point: 1 });

    socket.receive(snapshotMessage({ revision: 3 }));
    await settle();

    expect(selected(db)).toBeNull();
  });

  it("is dropped when a roll or an undo is sent", async () => {
    const { db } = await playing(0);

    db.ops.game.selectPoint({ gameId: GAME_ID, point: 1 });
    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "undo" } });

    expect(selected(db)).toBeNull();
  });
});

describe("a checker that has moved", () => {
  /** A game in which this browser's user is seat 0, mid-turn with a 6 and a 3 to play. */
  async function midTurn() {
    const ctx = setup();
    await settle(); // the session registers as issued(1), so its user id is user-1
    const players = [issued(1).userId, "other"];
    const state = startingState({
      ...moving([6, 3], [{ from: 1, die: 6 }, { from: 1, die: 3 }, { from: 5, die: 3 }]),
    });
    const socket = await connected(ctx.db, { players, state });
    ctx.db.ops.game.selectPoint({ gameId: GAME_ID, point: 5 });
    ctx.db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "move", from: 5, die: 3 } });
    return { ...ctx, socket, players };
  }
  const selected = (db: TestDb) => view(db)?.selected;

  /** The answer to the move 5 to 8: the 6 is left to play, with these steps legal. */
  const answer = (players: string[], legal: { from: number; die: number }[]) =>
    snapshotMessage({
      revision: 2,
      players,
      state: startingState({ ...moving([6, 3], legal, [{ from: 5, die: 3 }], [6]) }),
    });

  it("is selected again where it lands, for the next die", async () => {
    const { db, socket, players } = await midTurn();
    expect(selected(db)).toBe(8);

    socket.receive(answer(players, [{ from: 8, die: 6 }, { from: 1, die: 6 }]));
    await settle();

    expect(view(db)).toMatchObject({ busy: false, selected: 8 });
  });

  it("is let go when it cannot move on, even if another checker can", async () => {
    const { db, socket, players } = await midTurn();

    socket.receive(answer(players, [{ from: 1, die: 6 }]));
    await settle();

    expect(view(db)).toMatchObject({ busy: false, selected: null });
  });

  it("is let go when the move ended the turn", async () => {
    const { db, socket, players } = await midTurn();

    // The other seat is to roll. A point that happens to be playable by them is not ours.
    socket.receive(
      snapshotMessage({ revision: 2, players, state: startingState({ turn: 1, legal: [{ from: 8, die: 6 }] }) }),
    );
    await settle();

    expect(selected(db)).toBeNull();
  });

  it("is let go when the server refuses the move", async () => {
    const { db, socket } = await midTurn();

    socket.receive({ type: "error", code: "rejected", message: "that move is blocked" });
    await settle();

    expect(view(db)).toMatchObject({ busy: false, selected: null, error: "that move is blocked" });
  });

  it("is not followed off the board", async () => {
    const { db } = setup();
    await settle();
    const players = [issued(1).userId, "other"];
    const state = startingState({ ...moving([6, 5], [{ from: 20, die: 5 }]), points: [board({ 20: 15 }), board({ 1: 15 })] });
    await connected(db, { players, state });
    db.ops.game.selectPoint({ gameId: GAME_ID, point: 20 });

    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "move", from: 20, die: 5 } });

    expect(selected(db)).toBeNull();
  });

  it("is let go when the move could not be sent", async () => {
    const { db, socket } = await midTurn();

    // The socket drops before the queued move goes out, which the server never sees.
    socket.serverClose(1006);
    await settle();

    expect(view(db)).toMatchObject({ busy: false, selected: null });
  });
});

describe("auto-play", () => {
  // Fake timers freeze the pauses. `settle` waits on a timer, so these tests flush with `tick`.
  const tick = () => vi.advanceTimersByTimeAsync(0);
  const actionsOf = (socket: FakeWebSocket) =>
    socket.sent.filter((m) => m.type === "action").map((m) => m.action);
  const legal = [
    { from: 1, die: 6 },
    { from: 1, die: 3 },
    { from: 5, die: 3 },
  ];

  /** A game in which this browser's user holds `seat`, with White (seat 0) to roll. */
  async function playing(seat: 0 | 1 = 0, state = startingState()) {
    vi.useFakeTimers();
    const ctx = setup();
    await tick();
    await tick(); // the session registers as issued(1), so its user id is user-1
    ctx.db.ops.game.openGame({ gameId: GAME_ID });
    await tick();
    const socket = FakeWebSocket.last;
    socket.open();
    const players = seat === 0 ? [issued(1).userId, "other"] : ["other", issued(1).userId];
    socket.receive(snapshotMessage({ players, state }));
    await tick();
    return { ...ctx, socket, players };
  }
  const auto = (db: TestDb) => view(db)?.auto;
  const pause = async (ms = AUTOPLAY_PAUSE_MS) => {
    await vi.advanceTimersByTimeAsync(ms);
    await tick();
  };

  it("is off when a game opens", async () => {
    const { db, socket } = await playing();

    expect(auto(db)).toBe(false);
    await pause(AUTOPLAY_PAUSE_MS * 5);
    expect(actionsOf(socket)).toEqual([]);
  });

  it("rolls for the player after a pause", async () => {
    const { db, socket } = await playing();

    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause(AUTOPLAY_PAUSE_MS - 1);
    expect(actionsOf(socket)).toEqual([]);
    await pause(1);

    expect(actionsOf(socket)).toEqual([{ type: "roll" }]);
  });

  it("then takes a checker off the head, as it does whenever it can, once the dice are rolled", async () => {
    const { db, socket, players } = await playing();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.99); // the last of the two off the head
    try {
      db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
      await pause();

      socket.receive(
        snapshotMessage({ revision: 2, players, state: startingState(moving([6, 3], legal)) }),
      );
      await tick();
      await pause();

      expect(actionsOf(socket)).toEqual([{ type: "roll" }, { type: "move", from: 1, die: 3 }]);
    } finally {
      random.mockRestore();
    }
  });

  it("leaves nothing selected, since it never selected anything", async () => {
    const { db, socket, players } = await playing();
    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    socket.receive(
      snapshotMessage({ revision: 2, players, state: startingState(moving([6, 3], legal)) }),
    );
    await tick();
    await pause();

    expect(view(db)).toMatchObject({ busy: true, selected: null });
  });

  it("waits for the answer to an action before sending the next", async () => {
    const { db, socket } = await playing();

    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause(AUTOPLAY_PAUSE_MS * 6);

    expect(actionsOf(socket)).toEqual([{ type: "roll" }]);
  });

  it("does nothing while it is the opponent's turn", async () => {
    const { db, socket } = await playing(1); // seat 0 is to roll

    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause(AUTOPLAY_PAUSE_MS * 5);

    expect(auto(db)).toBe(true);
    expect(actionsOf(socket)).toEqual([]);
  });

  it("starts again when the turn comes round", async () => {
    const { db, socket, players } = await playing(1);
    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause(AUTOPLAY_PAUSE_MS * 2);
    expect(actionsOf(socket)).toEqual([]);

    socket.receive(snapshotMessage({ revision: 5, players, state: startingState({ turn: 1 }) }));
    await tick();
    await pause();

    expect(actionsOf(socket)).toEqual([{ type: "roll" }]);
  });

  it("stops at once when it is switched off", async () => {
    const { db, socket } = await playing();
    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause(AUTOPLAY_PAUSE_MS - 100);

    db.ops.game.setAutoplay({ gameId: GAME_ID, on: false });
    await pause(AUTOPLAY_PAUSE_MS * 3);

    expect(auto(db)).toBe(false);
    expect(actionsOf(socket)).toEqual([]);
  });

  it("can be switched on only by a player", async () => {
    vi.useFakeTimers();
    const { db } = setup();
    await tick();
    await tick();
    db.ops.game.openGame({ gameId: GAME_ID });
    await tick();
    FakeWebSocket.last.open();
    FakeWebSocket.last.receive(snapshotMessage({ players: ["a", "b"] })); // the user is neither
    await tick();

    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });

    expect(auto(db)).toBe(false);
  });

  it("switches itself off when the server refuses what it sent", async () => {
    const { db, socket } = await playing();
    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause();
    expect(actionsOf(socket)).toHaveLength(1);

    socket.receive({ type: "error", code: "rejected", message: "that is not allowed" });
    await tick();
    await pause(AUTOPLAY_PAUSE_MS * 4);

    expect(view(db)).toMatchObject({ auto: false, error: "that is not allowed" });
    expect(actionsOf(socket)).toHaveLength(1);
  });

  it("does not send while the connection is down", async () => {
    const { db, socket } = await playing();
    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause(AUTOPLAY_PAUSE_MS - 100);

    socket.serverClose(1006);
    await tick();
    await pause(150);

    expect(actionsOf(socket)).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(1); // the retry is still a second away
  });

  it("ends with the page", async () => {
    const { db, socket } = await playing();
    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });

    db.ops.game.closeGame({ gameId: GAME_ID });
    await pause(AUTOPLAY_PAUSE_MS * 3);

    expect(actionsOf(socket)).toEqual([]);
  });
});

describe("a combined move", () => {
  // Fake timers freeze the pause between the steps. `settle` waits on a timer, so these tests flush with `tick`.
  const tick = () => vi.advanceTimersByTimeAsync(0);
  const actionsOf = (socket: FakeWebSocket) =>
    socket.sent.filter((m) => m.type === "action").map((m) => m.action);
  const queued = (db: TestDb) => view(db)?.queued;

  // A 3-6: the checker on 1 can play the 3 to 4 and then the 6 to 10.
  const three = { from: 1, die: 3 };
  const six = { from: 4, die: 6 };
  const start = startingState({
    ...moving([3, 6], [three, { from: 1, die: 6 }], [], [3, 6], [[three, six]]),
  });
  /** What the server sends once the 3 is played: the 6 is left, and the checker on 4 can play it. */
  const afterThree = (players: string[], legal = [six]) =>
    snapshotMessage({
      revision: 2,
      players,
      state: startingState({ ...moving([3, 6], legal, [three], [6]) }),
    });

  /** A game in which this browser's user is seat 0 and to move, with the 3-6 above rolled. */
  async function ready(state = start) {
    vi.useFakeTimers();
    const ctx = setup();
    await tick();
    await tick(); // the session registers as issued(1), so its user id is user-1
    ctx.db.ops.game.openGame({ gameId: GAME_ID });
    await tick();
    const socket = FakeWebSocket.last;
    socket.open();
    const players = [issued(1).userId, "other"];
    socket.receive(snapshotMessage({ players, state }));
    await tick();
    return { ...ctx, socket, players };
  }
  const play = async (db: TestDb, steps: { from: number; die: number }[]) => {
    db.ops.game.submitMoves({ gameId: GAME_ID, steps });
    await tick();
  };
  const pause = async (ms = QUEUED_STEP_PAUSE_MS) => {
    await vi.advanceTimersByTimeAsync(ms);
    await tick();
  };

  it("sends the first step at once and keeps the rest back", async () => {
    const { db, socket } = await ready();
    db.ops.game.selectPoint({ gameId: GAME_ID, point: 1 });

    await play(db, [three, six]);

    expect(actionsOf(socket)).toEqual([{ type: "move", ...three }]);
    expect(view(db)).toMatchObject({ busy: true, queued: [six], selected: null });
  });

  it("sends the next step only after the answer and a pause, so that the first hop can be followed", async () => {
    const { db, socket, players } = await ready();
    await play(db, [three, six]);

    socket.receive(afterThree(players));
    await tick();
    expect(view(db)).toMatchObject({ busy: false, queued: [six] });
    await pause(QUEUED_STEP_PAUSE_MS - 1);
    expect(actionsOf(socket)).toHaveLength(1);

    await pause(1);

    expect(actionsOf(socket)).toEqual([
      { type: "move", ...three },
      { type: "move", ...six },
    ]);
    expect(view(db)).toMatchObject({ busy: true, queued: [] });
  });

  it("does not send the second step before the first is answered, however long it takes", async () => {
    const { db, socket } = await ready();
    await play(db, [three, six]);

    await pause(QUEUED_STEP_PAUSE_MS * 10);

    expect(actionsOf(socket)).toHaveLength(1);
    expect(queued(db)).toEqual([six]);
  });

  it("starts nothing else in the middle: no pick, no roll, no other move", async () => {
    const { db, socket, players } = await ready();
    await play(db, [three, six]);
    socket.receive(afterThree(players, [six, { from: 1, die: 6 }]));
    await tick();

    db.ops.game.selectPoint({ gameId: GAME_ID, point: 1 });
    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "undo" } });
    db.ops.game.submitMoves({ gameId: GAME_ID, steps: [{ from: 1, die: 6 }] });
    await tick();

    expect(view(db)).toMatchObject({ selected: null, queued: [six] });
    expect(actionsOf(socket)).toHaveLength(1);
  });

  it("keeps the checker selected where it lands, if the dice allow it to go on", async () => {
    // A double: two 5s with the checker on 1 leave two more, and it can play on from 11.
    const five = { from: 1, die: 5 };
    const again = { from: 6, die: 5 };
    const state = startingState({
      ...moving([5, 5], [five], [], [5, 5, 5, 5], [[five, again]]),
    });
    const { db, socket, players } = await ready(state);
    await play(db, [five, again]);

    socket.receive(
      snapshotMessage({
        revision: 2,
        players,
        state: startingState({ ...moving([5, 5], [again, { from: 1, die: 5 }], [five], [5, 5, 5]) }),
      }),
    );
    await tick();
    await pause();
    expect(actionsOf(socket).at(-1)).toEqual({ type: "move", ...again });

    socket.receive(
      snapshotMessage({
        revision: 3,
        players,
        state: startingState({
          ...moving([5, 5], [{ from: 11, die: 5 }], [five, again], [5, 5]),
        }),
      }),
    );
    await tick();

    expect(view(db)).toMatchObject({ busy: false, queued: [], selected: 11 });
  });

  it("plays a single step like any other move, selecting the checker where it lands", async () => {
    const { db, socket } = await ready();
    db.ops.game.selectPoint({ gameId: GAME_ID, point: 1 });

    await play(db, [three]);

    expect(actionsOf(socket)).toEqual([{ type: "move", ...three }]);
    expect(view(db)).toMatchObject({ busy: true, queued: [], selected: 4 });
  });

  it("drops the rest, and says why, when the server refuses a step", async () => {
    const { db, socket } = await ready();
    await play(db, [three, six]);

    socket.receive({ type: "error", code: "rejected", message: "that move is blocked" });
    await tick();
    await pause(QUEUED_STEP_PAUSE_MS * 2);

    expect(view(db)).toMatchObject({ busy: false, queued: [], error: "that move is blocked" });
    expect(actionsOf(socket)).toHaveLength(1);
  });

  it("drops the rest when the position is not the one it was planned in", async () => {
    const { db, socket, players } = await ready();
    await play(db, [three, six]);

    // The answer does not list the 6 from 4: a second tab of the same player played on.
    socket.receive(afterThree(players, [{ from: 1, die: 6 }]));
    await tick();
    await pause(QUEUED_STEP_PAUSE_MS * 2);

    expect(queued(db)).toEqual([]);
    expect(actionsOf(socket)).toHaveLength(1);
  });

  it("drops the rest when it is no longer the user's turn", async () => {
    const { db, socket, players } = await ready();
    await play(db, [three, six]);

    socket.receive(
      snapshotMessage({ revision: 2, players, state: startingState({ turn: 1, legal: [six] }) }),
    );
    await tick();
    await pause(QUEUED_STEP_PAUSE_MS * 2);

    expect(queued(db)).toEqual([]);
    expect(actionsOf(socket)).toHaveLength(1);
  });

  it("drops the rest when the connection is lost, as an action meant for an old position must not play in a new one", async () => {
    const { db, socket, players } = await ready();
    await play(db, [three, six]);
    socket.receive(afterThree(players));
    await tick();

    socket.serverClose(1006);
    await tick();
    await pause(QUEUED_STEP_PAUSE_MS * 2);

    expect(view(db)).toMatchObject({ queued: [], busy: false });
    expect(actionsOf(socket)).toHaveLength(1);
  });

  it("is ignored while an earlier action waits for its answer, or the connection is down", async () => {
    const { db, socket } = await ready();
    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "undo" } });
    await tick();

    await play(db, [three, six]);

    expect(actionsOf(socket)).toEqual([{ type: "undo" }]);
    expect(queued(db)).toEqual([]);
  });

  it("is ignored when there is nothing to play", async () => {
    const { db, socket } = await ready();

    await play(db, []);

    expect(actionsOf(socket)).toEqual([]);
    expect(view(db)?.busy).toBe(false);
  });
});

describe("joining", () => {
  it("takes the seat, and the request is gone once the server agrees", async () => {
    const { db, server } = setup();
    server.addGame({ id: GAME_ID, kind: "long-backgammon", players: ["somebody-else"] });

    db.ops.game.joinGame({ gameId: GAME_ID });
    expect(db.read(joinRequests.get(GAME_ID))).toMatchObject({ state: "joining" });
    await settle();

    expect(server.games.get(GAME_ID)?.players).toEqual(["somebody-else", issued(1).userId]);
    expect(db.read(joinRequests.get(GAME_ID))).toBeUndefined();
  });

  it("tells the player the game does not exist", async () => {
    const { db } = setup();

    db.ops.game.joinGame({ gameId: GAME_ID });
    await settle();

    expect(db.read(joinRequests.get(GAME_ID))).toMatchObject({
      state: "failed",
      error: "This game does not exist any more.",
    });
  });

  it("tells the player the game is full, and can be tried again", async () => {
    const { db, server } = setup();
    server.addGame({ id: GAME_ID, kind: "long-backgammon", players: ["a", "b"] });

    db.ops.game.joinGame({ gameId: GAME_ID });
    await settle();
    expect(db.read(joinRequests.get(GAME_ID))).toMatchObject({
      state: "failed",
      error: "Both seats are taken.",
    });

    server.games.get(GAME_ID)?.players.pop();
    db.ops.game.joinGame({ gameId: GAME_ID });
    await settle();
    expect(db.read(joinRequests.get(GAME_ID))).toBeUndefined();
  });

  it("is dropped with the page", async () => {
    const { db } = setup();
    db.ops.game.openGame({ gameId: GAME_ID });
    db.ops.game.joinGame({ gameId: GAME_ID });

    db.ops.game.closeGame({ gameId: GAME_ID });

    expect(db.read(joinRequests.get(GAME_ID))).toBeUndefined();
  });
});

describe("a rematch", () => {
  const ME = issued(1).userId;
  const NEXT = gameIdOf(2);
  const over = startingState({ phase: { type: "over", winner: 0, points: 1, forfeited: false } });

  /** The message for a finished game that the user played in, as the server sends it. */
  const finished = (overrides: Record<string, unknown> = {}) => ({
    revision: 4,
    players: [ME, "user-b"],
    playerNames: ["Ada", "Grace"],
    state: over,
    ...overrides,
  });
  const offered = { type: "offered", by: 0 };
  const accepted = { type: "accepted", gameId: NEXT };

  /** The requests made about rematches, as "METHOD path". */
  const rematchCalls = (fetchMock: ReturnType<typeof setup>["fetchMock"]) =>
    fetchMock.mock.calls
      .map(([input, init]) => `${init?.method ?? "GET"} ${String(input)}`)
      .filter((call) => call.endsWith("/rematch"));
  const request = (db: TestDb) => db.read(rematchRequests.get(GAME_ID));
  const finishedGame = (server: ReturnType<typeof setup>["server"], players = [ME, "user-b"]) =>
    server.addGame({ id: GAME_ID, kind: "long-backgammon", players, finished: true });

  describe("in a snapshot", () => {
    it("is kept with the rest of the game", async () => {
      const { db } = setup();

      await connected(db, finished({ rematch: offered }));

      expect(view(db)?.snapshot?.rematch).toEqual(offered);
    });

    it("is none for a server from before rematches, which leaves it out", async () => {
      const { db } = setup();
      db.ops.game.openGame({ gameId: GAME_ID });
      await settle();
      FakeWebSocket.last.open();
      const { rematch: _, ...old } = snapshotMessage(finished());

      FakeWebSocket.last.receive(old);
      await settle();

      expect(view(db)).toMatchObject({ problem: null, snapshot: { rematch: null } });
    });
  });

  describe("asking", () => {
    it("is a POST, and the request is gone once the server has taken it", async () => {
      const { db, server, fetchMock } = setup();
      finishedGame(server);
      await connected(db, finished());

      db.ops.game.askRematch({ gameId: GAME_ID });
      expect(request(db)).toMatchObject({ answer: "ask", state: "sending" });
      await settle();

      expect(rematchCalls(fetchMock)).toEqual([`POST /api/games/${GAME_ID}/rematch`]);
      expect(request(db)).toBeUndefined();
    });

    it("is one request, however many times the button is pressed", async () => {
      const { db, server, fetchMock } = setup();
      finishedGame(server);
      await connected(db, finished());

      db.ops.game.askRematch({ gameId: GAME_ID });
      db.ops.game.askRematch({ gameId: GAME_ID });
      db.ops.game.declineRematch({ gameId: GAME_ID });
      await settle();

      expect(rematchCalls(fetchMock)).toEqual([`POST /api/games/${GAME_ID}/rematch`]);
    });

    it("changes nothing in the game until the server says so in a snapshot", async () => {
      const { db, server } = setup();
      finishedGame(server);
      await connected(db, finished());

      db.ops.game.askRematch({ gameId: GAME_ID });
      await settle();

      expect(view(db)?.snapshot?.rematch).toBeNull();
    });
  });

  describe("declining", () => {
    it("is a DELETE, for taking back one's own ask or turning down the other's", async () => {
      const { db, server, fetchMock } = setup();
      finishedGame(server);
      await connected(db, finished({ rematch: offered }));

      db.ops.game.declineRematch({ gameId: GAME_ID });
      expect(request(db)).toMatchObject({ answer: "decline", state: "sending" });
      await settle();

      expect(rematchCalls(fetchMock)).toEqual([`DELETE /api/games/${GAME_ID}/rematch`]);
      expect(request(db)).toBeUndefined();
    });
  });

  describe("when the server refuses", () => {
    it("says the game is not over, and can be tried again", async () => {
      const { db, server } = setup();
      server.addGame({ id: GAME_ID, kind: "long-backgammon", players: [ME, "user-b"] });
      await connected(db, finished());

      db.ops.game.askRematch({ gameId: GAME_ID });
      await settle();
      expect(request(db)).toMatchObject({ state: "failed", error: "The game is not over yet." });

      const stored = server.games.get(GAME_ID);
      if (stored) stored.finished = true;
      db.ops.game.askRematch({ gameId: GAME_ID });
      await settle();
      expect(request(db)).toBeUndefined();
    });

    it("says only the players can ask, to someone who is watching", async () => {
      const { db, server } = setup();
      finishedGame(server, ["user-a", "user-b"]);
      await connected(db, finished({ players: ["user-a", "user-b"] }));

      db.ops.game.askRematch({ gameId: GAME_ID });
      await settle();

      expect(request(db)).toMatchObject({
        state: "failed",
        error: "Only the players of this game can do that.",
      });
    });

    it("says the game is gone", async () => {
      const { db } = setup();
      await connected(db, finished());

      db.ops.game.askRematch({ gameId: GAME_ID });
      await settle();

      expect(request(db)).toMatchObject({
        state: "failed",
        error: "This game does not exist any more.",
      });
    });

    it("does not show a network error in the browser's words", async () => {
      const { db, server, fetchMock } = setup();
      finishedGame(server);
      await connected(db, finished());
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      db.ops.game.askRematch({ gameId: GAME_ID });
      await settle();

      expect(request(db)).toMatchObject({
        state: "failed",
        error: "Something went wrong on the server. Try again.",
      });
    });

    it("forgets the failure when the game moves on, since it was about the game as it was", async () => {
      const { db } = setup();
      const socket = await connected(db, finished());
      db.ops.game.askRematch({ gameId: GAME_ID });
      await settle();
      expect(request(db)).toMatchObject({ state: "failed" });

      socket.receive(snapshotMessage(finished({ revision: 5, rematch: { type: "offered", by: 1 } })));
      await settle();

      expect(request(db)).toBeUndefined();
    });

    it("keeps a request that is still on its way when the game moves on", async () => {
      const { db, server } = setup();
      finishedGame(server);
      const socket = await connected(db, finished());
      db.ops.game.askRematch({ gameId: GAME_ID });

      socket.receive(snapshotMessage(finished({ revision: 5, rematch: { type: "offered", by: 1 } })));

      expect(request(db)).toMatchObject({ state: "sending" });
    });
  });

  it("is dropped, request and all, with the page", async () => {
    const { db } = setup();
    db.ops.game.openGame({ gameId: GAME_ID });
    db.ops.game.askRematch({ gameId: GAME_ID });

    db.ops.game.closeGame({ gameId: GAME_ID });

    expect(request(db)).toBeUndefined();
  });

  describe("starting", () => {
    const path = (db: TestDb) => db.read(locationState.get(LOCATION_ID))?.path;

    it("takes a player to the new game when the page sees it start", async () => {
      const { db, pushState } = setup();
      const socket = await connected(db, finished({ rematch: offered }));
      expect(pushState).not.toHaveBeenCalled();

      socket.receive(snapshotMessage(finished({ revision: 5, rematch: accepted })));
      await settle();

      expect(view(db)?.rematchStarted).toBe(NEXT);
      expect(pushState).toHaveBeenCalledWith(null, "", `/games/${NEXT}`);
      expect(path(db)).toBe(`/games/${NEXT}`);
    });

    it("does so at once against the computer, which accepts without an offer in between", async () => {
      const { db, pushState } = setup();
      const socket = await connected(db, finished());

      // Against the computer there is no offer in between.
      socket.receive(snapshotMessage(finished({ revision: 5, rematch: accepted })));
      await settle();

      expect(pushState).toHaveBeenCalledWith(null, "", `/games/${NEXT}`);
    });

    it("does so after a gap of several changes too, as when the connection was down", async () => {
      const { db, pushState } = setup();
      const socket = await connected(db, finished({ rematch: offered }));

      socket.receive(snapshotMessage(finished({ revision: 9, rematch: accepted })));
      await settle();

      expect(pushState).toHaveBeenCalledWith(null, "", `/games/${NEXT}`);
    });

    it("goes once, however many times the server repeats itself", async () => {
      const { db, pushState } = setup();
      const socket = await connected(db, finished({ rematch: offered }));

      for (const playerNames of [["Ada", "Grace"], ["Ada", "Grace Hopper"], ["Ada", "Grace"]]) {
        socket.receive(snapshotMessage(finished({ revision: 5, rematch: accepted, playerNames })));
        await settle();
      }

      expect(pushState).toHaveBeenCalledTimes(1);
    });

    it("leaves alone a page that opens on a rematch that has begun already", async () => {
      const { db, pushState } = setup();

      await connected(db, finished({ rematch: accepted }));

      expect(view(db)?.rematchStarted).toBeNull();
      expect(pushState).not.toHaveBeenCalled();
    });

    it("leaves a spectator where they are", async () => {
      const { db, pushState } = setup();
      const watching = { players: ["user-a", "user-b"] };
      const socket = await connected(db, finished({ ...watching, rematch: offered }));

      socket.receive(snapshotMessage(finished({ ...watching, revision: 5, rematch: accepted })));
      await settle();

      expect(view(db)?.rematchStarted).toBeNull();
      expect(pushState).not.toHaveBeenCalled();
    });

    it("does not follow an offer, a refusal or a withdrawn ask", async () => {
      const { db, pushState } = setup();
      const socket = await connected(db, finished());

      for (const [revision, rematch] of [
        [5, offered],
        [6, { type: "declined", by: 0 }],
        [7, null],
      ] as const) {
        socket.receive(snapshotMessage(finished({ revision, rematch })));
        await settle();
      }

      expect(pushState).not.toHaveBeenCalled();
    });
  });
});

describe("reviewing a game", () => {
  // One turn of seat 0 (White), then the next player is to roll. The server keeps the position
  // without `legal` and `combos`; the revision is the one the position had.
  const rolled = startingState(moving([6, 3], [{ from: 1, die: 6 }, { from: 1, die: 3 }]));
  const afterSix = startingState({
    points: [board({ 1: 14, 7: 1 }), board({ 1: 15 })],
    ...moving([6, 3], [{ from: 7, die: 3 }], [{ from: 1, die: 6 }], [3]),
  });
  const turnOver = startingState({
    turn: 1,
    turns: [1, 0],
    points: [board({ 1: 14, 10: 1 }), board({ 1: 15 })],
    lastTurn: { seat: 0, dice: [6, 3], played: [{ from: 1, die: 6 }, { from: 7, die: 3 }] },
  });
  const over = startingState({
    off: [15, 2],
    turns: [41, 40],
    phase: { type: "over", winner: 0, points: 1, forfeited: false },
    lastTurn: { seat: 0, dice: [1, 2], played: [{ from: 24, die: 1 }] },
  });

  const kept = (...positions: [number, ReturnType<typeof startingState>][]) =>
    positions.map(([revision, { legal: _legal, combos: _combos, ...state }]) => ({ revision, state }));
  const review = (db: TestDb) => db.read(reviews.get(GAME_ID));
  const revisions = (db: TestDb) => review(db)?.frames.map((frame) => frame.revision);
  const historyCalls = (fetchMock: ReturnType<typeof setup>["fetchMock"]) =>
    fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/history"));
  const keep = (server: ReturnType<typeof setup>["server"], history: ReturnType<typeof kept>, kind = "long-backgammon") =>
    server.addGame({ id: GAME_ID, kind, players: ["user-a", "user-b"], history });

  /** Opens the review of a game whose snapshot is at `revision`, and waits for the positions. */
  async function opened(db: TestDb, revision: number, state = afterSix) {
    const socket = await connected(db, { revision, state });
    db.ops.game.openReview({ gameId: GAME_ID });
    await settle();
    return socket;
  }

  describe("keeping the review of a game that always has one", () => {
    const keepFor = (db: TestDb, userId: string | null) => db.ops.game.keepReview({ gameId: GAME_ID, userId });
    // The players of the fixtures' snapshots are user-a and user-b. The session's user is neither.
    const WATCHER = "user-1";

    it("opens the review for a user who only watches a game that has been played in", async () => {
      const { db, server, fetchMock } = setup();
      keep(server, kept([1, startingState()], [2, rolled], [3, afterSix]));
      await connected(db, { revision: 3, state: afterSix });

      keepFor(db, WATCHER);
      expect(review(db)).toMatchObject({ load: "loading", frames: [], at: null });
      await settle();

      expect(historyCalls(fetchMock)).toHaveLength(1);
      expect(review(db)).toMatchObject({ load: "ready", through: 3, at: null });
      expect(revisions(db)).toEqual([1, 2, 3]);
    });

    // One db to a test: the sockets of a game are kept by its id, for the whole process.
    it.each(["user-a", "user-b", WATCHER])("opens it for %s, a player or a watcher of a game that is over", async (userId) => {
      const { db, server } = setup();
      keep(server, kept([1, startingState()], [9, over]));
      await connected(db, { revision: 9, state: over });

      keepFor(db, userId);

      expect(review(db)).toMatchObject({ load: "loading" });
    });

    it("leaves a game in progress to its players, who open the review when they want to look back", async () => {
      const { db } = setup();
      await connected(db, { revision: 3, state: afterSix });

      keepFor(db, "user-a");
      keepFor(db, "user-b");

      expect(review(db)).toBeUndefined();
    });

    it("waits until something has been played: before it there is nothing to step through", async () => {
      const { db } = setup();
      await connected(db, { revision: 1, state: startingState() });

      keepFor(db, WATCHER);

      expect(review(db)).toBeUndefined();
    });

    it("opens it as soon as the first move is made", async () => {
      const { db, server } = setup();
      keep(server, kept([1, startingState()], [2, rolled]));
      const socket = await connected(db, { revision: 1, state: startingState() });
      keepFor(db, WATCHER);
      expect(review(db)).toBeUndefined();

      socket.receive(snapshotMessage({ revision: 2, state: rolled }));
      await settle();
      keepFor(db, WATCHER);

      expect(review(db)).toMatchObject({ load: "loading" });
    });

    it("does not take a user who is not known yet for a watcher", async () => {
      const { db } = setup();
      await connected(db, { revision: 3, state: afterSix });

      keepFor(db, null);

      expect(review(db)).toBeUndefined();
    });

    it("does nothing without a game on the page", async () => {
      const { db } = setup();

      keepFor(db, WATCHER);

      expect(review(db)).toBeUndefined();
    });

    it("leaves a review that is open as it is, with what it has loaded and where the user is in it", async () => {
      const { db, server, fetchMock } = setup();
      keep(server, kept([1, startingState()], [2, rolled], [3, afterSix]));
      await connected(db, { revision: 3, state: afterSix });
      keepFor(db, WATCHER);
      await settle();
      db.ops.game.showFrame({ gameId: GAME_ID, index: 1 });

      keepFor(db, WATCHER);
      await settle();

      expect(historyCalls(fetchMock)).toHaveLength(1);
      expect(review(db)).toMatchObject({ load: "ready", at: 1 });
    });

    it("opens it again if it was closed: the page calls this whenever the review is gone", async () => {
      const { db, server } = setup();
      keep(server, kept([1, startingState()], [2, rolled], [3, afterSix]));
      await connected(db, { revision: 3, state: afterSix });
      keepFor(db, WATCHER);
      await settle();
      db.ops.game.closeReview({ gameId: GAME_ID });

      keepFor(db, WATCHER);
      await settle();

      expect(revisions(db)).toEqual([1, 2, 3]);
    });

    it("follows the game a watcher is watching: the next move is one more frame", async () => {
      const { db, server } = setup();
      keep(server, kept([1, startingState()], [2, rolled], [3, afterSix]));
      const socket = await connected(db, { revision: 3, state: afterSix });
      keepFor(db, WATCHER);
      await settle();

      socket.receive(snapshotMessage({ revision: 4, state: turnOver }));
      await settle();

      expect(revisions(db)).toEqual([1, 2, 3, 4]);
      expect(review(db)?.at).toBeNull();
    });
  });

  describe("opening", () => {
    it("asks the server for the positions, with the user's token, and keeps them as frames", async () => {
      const { db, server, fetchMock } = setup();
      keep(server, kept([1, startingState()], [2, rolled], [3, afterSix]));
      await connected(db, { revision: 3, state: afterSix });

      db.ops.game.openReview({ gameId: GAME_ID });
      expect(review(db)).toMatchObject({ load: "loading", frames: [], at: null });
      await settle();

      const [input, init] = historyCalls(fetchMock)[0] ?? [];
      expect(String(input)).toBe(`/api/games/${GAME_ID}/history`);
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${issued(1).accessToken}`);
      expect(review(db)).toMatchObject({ load: "ready", error: null, through: 3, at: null });
      expect(revisions(db)).toEqual([1, 2, 3]);
    });

    it("keeps nothing in the frames that could be played", async () => {
      const { db, server } = setup();
      keep(server, kept([1, startingState()], [2, rolled]));
      await opened(db, 2, rolled);

      const states = review(db)?.frames.map((frame) => frame.state) ?? [];
      expect(states).toHaveLength(2);
      expect(states.every((state) => state.legal.length === 0 && state.combos.length === 0)).toBe(true);
    });

    it("leaves out the steps that were taken back", async () => {
      const { db, server } = setup();
      keep(
        server,
        kept([1, startingState()], [2, rolled], [3, afterSix], [4, rolled], [5, afterSix], [6, turnOver]),
      );
      await opened(db, 6, turnOver);

      expect(revisions(db)).toEqual([1, 2, 5, 6]);
      expect(review(db)?.through).toBe(6);
    });

    it("asks once, however many times it is pressed", async () => {
      const { db, server, fetchMock } = setup();
      keep(server, kept([1, startingState()], [2, rolled]));
      await connected(db, { revision: 2, state: rolled });

      db.ops.game.openReview({ gameId: GAME_ID });
      db.ops.game.openReview({ gameId: GAME_ID });
      await settle();
      db.ops.game.openReview({ gameId: GAME_ID });
      await settle();

      expect(historyCalls(fetchMock)).toHaveLength(1);
    });

    it("needs a game that has started", async () => {
      const { db, fetchMock } = setup();
      await connected(db, { players: ["user-a"], playerNames: ["Ada"], state: null });

      db.ops.game.openReview({ gameId: GAME_ID });
      await settle();

      expect(review(db)).toBeUndefined();
      expect(historyCalls(fetchMock)).toHaveLength(0);
    });

    it("begins with the game as it stands when the server kept no positions, as for a game from before they were", async () => {
      const { db, server } = setup();
      keep(server, []);
      await opened(db, 30, afterSix);

      expect(review(db)).toMatchObject({ load: "ready", through: 30 });
      expect(revisions(db)).toEqual([30]);
    });

    it("adds a snapshot that came while the positions were on their way", async () => {
      const { db, server } = setup();
      keep(server, kept([1, startingState()], [2, rolled]));

      await opened(db, 3, afterSix); // the page holds revision 3; the server answers up to 2

      expect(revisions(db)).toEqual([1, 2, 3]);
      expect(review(db)?.through).toBe(3);
    });

    it("asks again when the answer is behind the game by more than one, and takes what the server has when asking again gets no further", async () => {
      const { db, server, fetchMock } = setup();
      keep(server, kept([1, startingState()], [2, rolled]));

      await opened(db, 5, turnOver);

      expect(historyCalls(fetchMock)).toHaveLength(2);
      expect(review(db)).toMatchObject({ load: "ready", through: 2 });
      expect(revisions(db)).toEqual([1, 2]);
    });
  });

  describe("following a game that goes on", () => {
    it("adds the position of each snapshot as a frame", async () => {
      const { db, server } = setup();
      keep(server, kept([1, startingState()], [2, rolled]));
      const socket = await opened(db, 2, rolled);

      socket.receive(snapshotMessage({ revision: 3, state: afterSix }));
      await settle();

      expect(revisions(db)).toEqual([1, 2, 3]);
      expect(review(db)?.through).toBe(3);
    });

    it("takes a step back as the frame it came from", async () => {
      const { db, server } = setup();
      keep(server, kept([1, startingState()], [2, rolled], [3, afterSix]));
      const socket = await opened(db, 3, afterSix);

      socket.receive(snapshotMessage({ revision: 4, state: rolled }));
      await settle();

      expect(revisions(db)).toEqual([1, 2]);
      expect(review(db)?.through).toBe(4);
    });

    it("asks the server again when snapshots were missed, and keeps the frames it has until the answer", async () => {
      const { db, server, fetchMock } = setup();
      keep(server, kept([1, startingState()], [2, rolled]));
      const socket = await opened(db, 2, rolled);
      keep(server, kept([1, startingState()], [2, rolled], [3, afterSix], [4, rolled], [5, afterSix]));

      socket.receive(snapshotMessage({ revision: 5, state: afterSix }));
      expect(review(db)).toMatchObject({ load: "loading", through: 2 });
      expect(revisions(db)).toEqual([1, 2]);
      await settle();

      expect(historyCalls(fetchMock)).toHaveLength(2);
      expect(review(db)).toMatchObject({ load: "ready", through: 5 });
      expect(revisions(db)).toEqual([1, 2, 5]);
    });

    it("adds nothing for the snapshots of a rematch, which come after the end", async () => {
      const { db, server, fetchMock } = setup();
      keep(server, kept([1, startingState()], [2, rolled], [3, over]));
      const socket = await opened(db, 3, over);

      socket.receive(snapshotMessage({ revision: 4, state: over, rematch: { type: "offered", by: 0 } }));
      socket.receive(snapshotMessage({ revision: 5, state: over, rematch: { type: "accepted", gameId: gameIdOf(2) } }));
      await settle();

      expect(historyCalls(fetchMock)).toHaveLength(1);
      expect(revisions(db)).toEqual([1, 2, 3]);
      expect(review(db)).toMatchObject({ load: "ready", through: 3 });
    });

    it("leaves a review that is still loading to the answer, which takes the newest snapshot", async () => {
      const { db, server } = setup();
      keep(server, kept([1, startingState()], [2, rolled]));
      const socket = await connected(db, { revision: 2, state: rolled });
      db.ops.game.openReview({ gameId: GAME_ID });

      socket.receive(snapshotMessage({ revision: 3, state: afterSix }));
      expect(review(db)).toMatchObject({ load: "loading", frames: [] });
      await settle();

      expect(revisions(db)).toEqual([1, 2, 3]);
    });
  });

  describe("stepping", () => {
    /** Frames at revisions 1, 2 and 3, with the review open on the newest. */
    async function threeFrames() {
      const ctx = setup();
      keep(ctx.server, kept([1, startingState()], [2, rolled], [3, afterSix]));
      const socket = await opened(ctx.db, 3, afterSix);
      return { ...ctx, socket };
    }
    const step = (db: TestDb, by: number) => db.ops.game.stepFrame({ gameId: GAME_ID, by });
    const show = (db: TestDb, index: number) => db.ops.game.showFrame({ gameId: GAME_ID, index });

    it("opens on the newest frame, which is no frame in particular", async () => {
      const { db } = await threeFrames();

      expect(review(db)?.at).toBeNull();
    });

    it("goes back a frame at a time, and stops at the first", async () => {
      const { db } = await threeFrames();

      step(db, -1);
      expect(review(db)?.at).toBe(1);
      step(db, -1);
      expect(review(db)?.at).toBe(0);
      step(db, -1);
      expect(review(db)?.at).toBe(0);
    });

    it("goes forward again, and the newest is the newest once more", async () => {
      const { db } = await threeFrames();
      show(db, 0);

      step(db, 1);
      expect(review(db)?.at).toBe(1);
      step(db, 1);
      expect(review(db)?.at).toBeNull();
      step(db, 1);
      expect(review(db)?.at).toBeNull();
    });

    it("jumps to a frame, and to either end", async () => {
      const { db } = await threeFrames();

      show(db, 1);
      expect(review(db)?.at).toBe(1);
      show(db, 0);
      expect(review(db)?.at).toBe(0);
      show(db, 99);
      expect(review(db)?.at).toBeNull();
      show(db, -4);
      expect(review(db)?.at).toBe(0);
    });

    it("stays on the frame it was put on while the game goes on", async () => {
      const { db, socket } = await threeFrames();
      show(db, 1);

      socket.receive(snapshotMessage({ revision: 4, state: turnOver }));
      await settle();

      expect(revisions(db)).toEqual([1, 2, 3, 4]);
      expect(review(db)?.at).toBe(1);
    });

    it("follows the game on the newest frame, which is where it opens", async () => {
      const { db, socket } = await threeFrames();

      socket.receive(snapshotMessage({ revision: 4, state: turnOver }));
      await settle();

      expect(review(db)?.at).toBeNull();
    });

    it("does nothing without frames", async () => {
      const { db } = setup();
      await connected(db, { revision: 2, state: rolled });
      db.ops.game.openReview({ gameId: GAME_ID });

      step(db, -1);
      show(db, 1);

      expect(review(db)?.at).toBeNull();
    });
  });

  describe("closing", () => {
    it("ends the review and nothing else: the game is still there", async () => {
      const { db, server } = setup();
      keep(server, kept([1, startingState()], [2, rolled]));
      await opened(db, 2, rolled);

      db.ops.game.closeReview({ gameId: GAME_ID });

      expect(review(db)).toBeUndefined();
      expect(view(db)?.snapshot?.revision).toBe(2);
    });

    it("can be opened again, and asks again, since the game may have gone on", async () => {
      const { db, server, fetchMock } = setup();
      keep(server, kept([1, startingState()], [2, rolled]));
      await opened(db, 2, rolled);
      db.ops.game.closeReview({ gameId: GAME_ID });

      db.ops.game.openReview({ gameId: GAME_ID });
      await settle();

      expect(historyCalls(fetchMock)).toHaveLength(2);
      expect(revisions(db)).toEqual([1, 2]);
    });

    it("goes with the page", async () => {
      const { db, server } = setup();
      keep(server, kept([1, startingState()], [2, rolled]));
      await opened(db, 2, rolled);

      db.ops.game.closeGame({ gameId: GAME_ID });

      expect(review(db)).toBeUndefined();
    });

    it("drops an answer that comes after the review was closed", async () => {
      const { db, server } = setup();
      keep(server, kept([1, startingState()], [2, rolled]));
      await connected(db, { revision: 2, state: rolled });
      db.ops.game.openReview({ gameId: GAME_ID });

      db.ops.game.closeReview({ gameId: GAME_ID });
      await settle();

      expect(review(db)).toBeUndefined();
    });
  });

  describe("when the positions cannot be had", () => {
    it("says the game is gone for a 404", async () => {
      const { db } = setup();
      await connected(db, { revision: 2, state: rolled });

      db.ops.game.openReview({ gameId: GAME_ID });
      await settle();

      expect(review(db)).toMatchObject({ load: "failed", error: "This game does not exist any more." });
    });

    it("says something went wrong for a failure of the server or the network, and can be tried again", async () => {
      const { db, server, fetchMock } = setup();
      keep(server, kept([1, startingState()], [2, rolled]));
      await connected(db, { revision: 2, state: rolled });
      fetchMock.mockImplementationOnce(async () => new Response(null, { status: 500 }));

      db.ops.game.openReview({ gameId: GAME_ID });
      await settle();
      expect(review(db)).toMatchObject({ load: "failed", error: "Something went wrong on the server. Try again." });

      fetchMock.mockImplementationOnce(async () => {
        throw new TypeError("network down");
      });
      db.ops.game.retryReview({ gameId: GAME_ID });
      expect(review(db)).toMatchObject({ load: "loading", error: null });
      await settle();
      expect(review(db)).toMatchObject({ load: "failed", error: "Something went wrong on the server. Try again." });

      db.ops.game.retryReview({ gameId: GAME_ID });
      await settle();
      expect(review(db)).toMatchObject({ load: "ready", error: null });
      expect(revisions(db)).toEqual([1, 2]);
    });

    it("keeps the frames it has when asking again fails", async () => {
      const { db, server, fetchMock } = setup();
      keep(server, kept([1, startingState()], [2, rolled]));
      const socket = await opened(db, 2, rolled);
      fetchMock.mockImplementationOnce(async () => new Response(null, { status: 500 }));

      socket.receive(snapshotMessage({ revision: 5, state: afterSix })); // skips some
      await settle();

      expect(review(db)).toMatchObject({ load: "failed" });
      expect(revisions(db)).toEqual([1, 2]);
    });

    it("does not retry unless it failed", async () => {
      const { db, server, fetchMock } = setup();
      keep(server, kept([1, startingState()], [2, rolled]));
      await opened(db, 2, rolled);

      db.ops.game.retryReview({ gameId: GAME_ID });
      await settle();

      expect(historyCalls(fetchMock)).toHaveLength(1);
    });

    it("says the page needs reloading for another kind of game", async () => {
      const { db, server } = setup();
      keep(server, kept([1, startingState()]), "chess");
      await connected(db, { revision: 2, state: rolled });

      db.ops.game.openReview({ gameId: GAME_ID });
      await settle();

      expect(review(db)).toMatchObject({
        load: "failed",
        error: "This link is for a different kind of game than this page can show.",
      });
    });

    it("says the page needs reloading for a position it cannot read", async () => {
      const { db, server } = setup();
      server.addGame({
        id: GAME_ID,
        kind: "long-backgammon",
        players: ["user-a", "user-b"],
        history: [{ revision: 1, state: { somethingNew: true } }],
      });
      await connected(db, { revision: 2, state: rolled });

      db.ops.game.openReview({ gameId: GAME_ID });
      await settle();

      expect(review(db)).toMatchObject({
        load: "failed",
        error: "This game needs a newer version of the site. Reload the page to get it.",
      });
    });
  });
});

describe("forfeiting", () => {
  const me = issued(1).userId;
  const forfeit = (db: TestDb) => db.ops.game.forfeitGame({ gameId: GAME_ID });
  const messages = (socket: FakeWebSocket) => socket.sent.filter((m) => m.type !== "hello");
  const over = (winner: 0 | 1) =>
    startingState({ phase: { type: "over", winner, points: 1, forfeited: true } });

  it("sends the forfeit as a message of its own, not as an action, and waits for the answer", async () => {
    const { db } = setup();
    const socket = await connected(db, { players: [me, "other"] });

    forfeit(db);
    await settle();

    expect(messages(socket)).toEqual([{ type: "forfeit" }]);
    expect(view(db)?.busy).toBe(true);
    expect(db.read(gameActions.all())).toEqual([]);
  });

  it("is allowed when it is the other player's turn", async () => {
    const { db } = setup();
    // Seat 0 is to move; this browser's user is seat 1.
    const socket = await connected(db, { players: ["other", me] });

    forfeit(db);
    await settle();

    expect(messages(socket)).toEqual([{ type: "forfeit" }]);
  });

  it("is allowed in the middle of a turn, and drops what is left of a combined move", async () => {
    const { db } = setup();
    const three = { from: 1, die: 3 };
    const six = { from: 4, die: 6 };
    const start = startingState({
      ...moving([3, 6], [three, { from: 1, die: 6 }], [], [3, 6], [[three, six]]),
    });
    const socket = await connected(db, { players: [me, "other"], state: start });
    db.ops.game.submitMoves({ gameId: GAME_ID, steps: [three, six] });
    await settle();
    // The server has played the 3. The 6 is queued, and nothing is waiting for an answer.
    socket.receive(
      snapshotMessage({
        revision: 2,
        players: [me, "other"],
        state: startingState({ ...moving([3, 6], [six], [three], [6]) }),
      }),
    );
    await Promise.resolve();
    expect(view(db)).toMatchObject({ busy: false, queued: [six] });

    forfeit(db);
    await settle();

    expect(view(db)).toMatchObject({ busy: true, queued: [] });
    expect(messages(socket).at(-1)).toEqual({ type: "forfeit" });
  });

  it("is ignored by someone who is only watching", async () => {
    const { db } = setup();
    const socket = await connected(db, { players: ["one", "other"] });

    forfeit(db);
    await settle();

    expect(messages(socket)).toEqual([]);
    expect(view(db)?.busy).toBe(false);
  });

  it("is ignored before the game has started, and after it is over", async () => {
    const { db } = setup();
    const socket = await connected(db, { players: [me], playerNames: [null], state: null });
    forfeit(db);
    await settle();
    expect(messages(socket)).toEqual([]);

    socket.receive(snapshotMessage({ revision: 2, players: [me, "other"], state: over(1) }));
    await settle();
    forfeit(db);
    await settle();
    expect(messages(socket)).toEqual([]);
  });

  it("is ignored while an action waits for its answer, and while the connection is not open", async () => {
    const { db } = setup();
    const socket = await connected(db, { players: [me, "other"] });
    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "roll" } });
    await settle();

    forfeit(db);
    await settle();
    expect(messages(socket)).toEqual([{ type: "action", action: { type: "roll" } }]);

    socket.serverClose(1006);
    forfeit(db);
    await settle();
    expect(messages(socket)).toEqual([{ type: "action", action: { type: "roll" } }]);
  });

  it("ends with the snapshot of the finished game, which says it was a forfeit", async () => {
    const { db } = setup();
    const socket = await connected(db, { players: [me, "other"] });
    forfeit(db);
    await settle();

    socket.receive(snapshotMessage({ revision: 2, players: [me, "other"], state: over(1) }));
    await settle();

    expect(view(db)).toMatchObject({ busy: false, error: null });
    expect(view(db)?.snapshot?.state?.phase).toEqual({
      type: "over",
      winner: 1,
      points: 1,
      forfeited: true,
    });
  });

  it("shows the server's reason when it refuses, and is free to act again", async () => {
    const { db } = setup();
    const socket = await connected(db, { players: [me, "other"] });
    forfeit(db);
    await settle();

    socket.receive({ type: "error", code: "rejected", message: "the game is over" });
    await settle();

    expect(view(db)).toMatchObject({ busy: false, error: "the game is over" });
  });

  it("is refused as a state this client can't read when a server leaves out who forfeited", async () => {
    const { db } = setup();
    const socket = await connected(db, { players: [me, "other"] });
    const old = { type: "over", winner: 1, points: 1 };

    socket.receive(snapshotMessage({ revision: 2, state: { ...over(1), phase: old } }));
    await settle();

    // The page keeps what it had and says it needs a newer version.
    expect(view(db)?.problem).toContain("newer version");
  });
});
