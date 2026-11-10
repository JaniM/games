import { createDb } from "millpond";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GAME_ID, hexSnapshotMessage, hexState, startingState, stones, utttState } from "../../fixtures";
import { FakeWebSocket, fakeServer, fakeStorage, issued, settle } from "../../testing";
import { router } from "../router";
import { session } from "../session";
import { AUTOPLAY_PAUSE_MS } from "./autoplay";
import { game, gameActions, gameViews, reviews } from "./index";
import type { HexState } from "./schemas";

// A Hex game goes through the same socket, ops and effects as the other games. These are the parts
// that are about the kind: reading its state, what a player sends (a stone, and the swap), its
// history, and auto-play.

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
  socket.receive(hexSnapshotMessage(message));
  await settle();
  return socket;
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Red (seat 0) has opened on f6, and Blue may swap. */
const opened = hexState({
  cells: stones({ f6: 0 }),
  turn: 1,
  last: { seat: 0, column: 5, row: 5, swap: false },
  canSwap: true,
});

describe("reading a snapshot", () => {
  it("keeps it with its kind, and the state of the game", async () => {
    const { db } = setup();

    await connected(db, { revision: 2, state: opened });

    const snapshot = view(db)?.snapshot;
    expect(snapshot?.kind).toBe("hex");
    expect(snapshot).toMatchObject({ revision: 2, players: ["user-a", "user-b"], state: opened });
    expect(view(db)).toMatchObject({ connection: "open", problem: null });
  });

  it("keeps a game that is waiting for a player, which has no state yet", async () => {
    const { db } = setup();

    await connected(db, { players: ["u1"], playerNames: ["Ada"], playerGuests: [false], state: null });

    expect(view(db)?.snapshot).toMatchObject({ kind: "hex", players: ["u1"], state: null });
  });

  it("is a problem to show when the state is another game's, though the kind says Hex", async () => {
    for (const state of [startingState(), utttState()]) {
      const { db } = setup();

      await connected(db, { state });

      expect(view(db)?.snapshot).toBeNull();
      expect(view(db)?.problem).toContain("newer version");
    }
  });

  it("is a problem to show when the board is not eleven by eleven, or has a stone of no seat", async () => {
    const short = { ...hexState(), cells: hexState().cells.slice(1) };
    const nobody = { ...hexState(), cells: [2, ...hexState().cells.slice(1)] };
    // Rows of cells, not the cells themselves.
    const rows = { ...hexState(), cells: Array.from({ length: 11 }, () => Array(11).fill(null)) };
    // A size this client doesn't draw, even with the cells to match it.
    const bigger = { ...hexState(), size: 13, cells: Array(13 * 13).fill(null) };
    const unsized = { ...hexState(), size: undefined };
    for (const state of [short, nobody, rows, bigger, unsized]) {
      const { db } = setup();

      await connected(db, { state });

      expect(view(db)?.snapshot).toBeNull();
      expect(view(db)?.problem).toContain("newer version");
    }
  });

  it("is a problem to show when the state has a layout this client does not read", async () => {
    const { db } = setup();

    await connected(db, { stateVersion: 2 });

    expect(view(db)?.snapshot).toBeNull();
    expect(view(db)?.problem).toContain("newer version");
  });
});

describe("playing a move", () => {
  const mine = { players: [me, "other"] };
  const blue = { players: ["other", me] };

  it("sends a stone to the server as an action, and waits for the answer", async () => {
    const { db } = setup();
    const socket = await connected(db, mine);

    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "place", column: 5, row: 5 } });
    await settle();

    expect(sent(socket)).toEqual([{ type: "action", action: { type: "place", column: 5, row: 5 } }]);
    expect(view(db)?.busy).toBe(true);
    expect(db.read(gameActions.all())).toEqual([]);
  });

  it("sends the swap as an action of its own", async () => {
    const { db } = setup();
    const socket = await connected(db, { ...blue, state: opened });

    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "swap" } });
    await settle();

    expect(sent(socket)).toEqual([{ type: "action", action: { type: "swap" } }]);
  });

  it("shows the server's reason when it refuses the move", async () => {
    const { db } = setup();
    const socket = await connected(db, mine);
    db.ops.game.submitAction({ gameId: GAME_ID, action: { type: "swap" } });
    await settle();

    socket.receive({ type: "error", code: "rejected", message: "the swap is only for Blue's first turn" });
    await settle();

    expect(view(db)).toMatchObject({ busy: false, error: "the swap is only for Blue's first turn" });
  });

  it("does not select a point: that is for checkers", async () => {
    const { db } = setup();
    await connected(db, mine);

    db.ops.game.selectPoint({ gameId: GAME_ID, point: 4 });

    expect(view(db)?.selected).toBeNull();
  });
});

describe("the review of a game", () => {
  const swapped = hexState({
    cells: stones({ f6: 1 }),
    turn: 0,
    swapped: true,
    last: { seat: 1, column: 5, row: 5, swap: true },
  });
  const history = [
    { revision: 1, state: hexState() },
    { revision: 2, state: opened },
    { revision: 3, state: swapped },
  ];
  const keep = (server: ReturnType<typeof setup>["server"], positions: unknown[] = history) =>
    server.addGame({
      id: GAME_ID,
      kind: "hex",
      players: ["user-a", "user-b"],
      history: positions as { revision: number; state: unknown }[],
    });

  it("is a frame for every position the server kept, the whole state of each", async () => {
    const { db, server } = setup();
    keep(server);
    await connected(db, { revision: 3, state: swapped });

    db.ops.game.openReview({ gameId: GAME_ID });
    await settle();

    const held = review(db);
    expect(held).toMatchObject({ load: "ready", through: 3, at: null });
    expect(held?.frames.map((frame) => frame.kind)).toEqual(["hex", "hex", "hex"]);
    const states = held?.frames.map((frame) => frame.state as HexState) ?? [];
    expect(states.map((state) => state.canSwap)).toEqual([false, true, false]);
    expect(states[2]?.last).toEqual({ seat: 1, column: 5, row: 5, swap: true });
  });

  it("follows the game: a snapshot that comes after is one more frame", async () => {
    const { db, server } = setup();
    keep(server);
    const socket = await connected(db, { revision: 3, state: swapped });
    db.ops.game.openReview({ gameId: GAME_ID });
    await settle();

    const answered = hexState({
      cells: stones({ f6: 1, e5: 0 }),
      turn: 1,
      swapped: true,
      last: { seat: 0, column: 4, row: 4, swap: false },
    });
    socket.receive(hexSnapshotMessage({ revision: 4, state: answered }));
    await settle();

    expect(review(db)?.frames.map((frame) => frame.revision)).toEqual([1, 2, 3, 4]);
  });

  it("fails as a page that needs reloading when a position is not one this client can read", async () => {
    const { db, server } = setup();
    keep(server, [{ revision: 1, state: { red: 0 } }]);
    await connected(db, { revision: 1 });

    db.ops.game.openReview({ gameId: GAME_ID });
    await settle();

    expect(review(db)?.load).toBe("failed");
  });

  it("is always on for a player of a game that is over", async () => {
    const { db, server } = setup();
    keep(server);
    const over = { ...swapped, phase: { type: "over", winner: 0, forfeited: true } };
    await connected(db, { players: [me, "other"], revision: 4, state: over });

    db.ops.game.keepReview({ gameId: GAME_ID, userId: me });
    await settle();

    expect(review(db)).toBeDefined();
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
    socket.sent.filter((m) => m.type === "action").map((m) => m.action as Record<string, unknown>);

  /** A game in which this browser's user holds `seat`, with Red (seat 0) to move. */
  async function playing(seat: 0 | 1 = 0, state = hexState()) {
    vi.useFakeTimers();
    const ctx = setup();
    await tick();
    await tick(); // the session registers as issued(1), so its user id is user-1
    ctx.db.ops.game.openGame({ gameId: GAME_ID });
    await tick();
    const socket = FakeWebSocket.last;
    socket.open();
    const players = seat === 0 ? [me, "other"] : ["other", me];
    socket.receive(hexSnapshotMessage({ players, state }));
    await tick();
    return { ...ctx, socket, players };
  }

  it("places a stone on an empty cell for the player after a pause", async () => {
    const { db, socket } = await playing();

    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause(AUTOPLAY_PAUSE_MS - 1);
    expect(actionsOf(socket)).toEqual([]);
    await pause(1);

    expect(actionsOf(socket)).toHaveLength(1);
    expect(actionsOf(socket)[0]).toMatchObject({ type: "place" });
    expect(view(db)).toMatchObject({ busy: true, selected: null });
  });

  it("plays Blue's turn too, and never on the stone that is there", async () => {
    const { db, socket } = await playing(1, opened);

    db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause();

    const [action] = actionsOf(socket);
    expect(action?.type === "swap" || action?.type === "place").toBe(true);
    expect(action).not.toEqual({ type: "place", column: 5, row: 5 });
  });

  it("does nothing while it is the opponent's turn, or once the game is over", async () => {
    const theirs = await playing(1);
    theirs.db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause(AUTOPLAY_PAUSE_MS * 3);
    expect(actionsOf(theirs.socket)).toEqual([]);

    for (const db of dbs.splice(0)) db.dispose();
    const over = await playing(0, hexState({ phase: { type: "over", winner: 1, forfeited: true } }));
    over.db.ops.game.setAutoplay({ gameId: GAME_ID, on: true });
    await pause(AUTOPLAY_PAUSE_MS * 3);
    expect(actionsOf(over.socket)).toEqual([]);
  });
});
