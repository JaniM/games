import { createDb } from "millpond";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GAME_ID, board, moving, snapshotMessage, startingState } from "../../fixtures";
import { FakeWebSocket, fakeServer, fakeStorage, gameIdOf, issued, settle } from "../../testing";
import { SESSION_ID, session, sessionState } from "../session";
import { AUTOPLAY_PAUSE_MS } from "./autoplay";
import { game, gameActions, gameViews, joinRequests } from "./index";

// A fresh db per test, from the same features the app uses.
const dbs: { dispose(): void }[] = [];
function setup() {
  const server = fakeServer();
  FakeWebSocket.reset();
  vi.stubGlobal("fetch", vi.fn(server.fetchImpl));
  vi.stubGlobal("localStorage", fakeStorage());
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "games.test" });
  const db = createDb({ features: { session, game } });
  dbs.push(db);
  db.ops.session.startSession({ stored: null });
  return { db, server };
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
