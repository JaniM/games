import { createDb } from "millpond";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeServer, fakeStorage, gameIdOf, issued, settle } from "../../testing";
import { LOCATION_ID, locationState, router } from "../router";
import { session } from "../session";
import { GAMES_LIST_ID, NEW_GAME_ID, gamesList, lobby, myGames, newGame } from "./index";

// A fresh db per test, from the same features the app uses.
const dbs: { dispose(): void }[] = [];
function setup(fetchImpl?: typeof fetch) {
  const server = fakeServer();
  const fetchMock = vi.fn(fetchImpl ?? server.fetchImpl);
  const pushState = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("localStorage", fakeStorage());
  vi.stubGlobal("history", { pushState });
  const db = createDb({ features: { session, router, lobby } });
  dbs.push(db);
  db.ops.session.startSession({ stored: null });
  return { db, server, fetchMock, pushState };
}
type TestDb = ReturnType<typeof setup>["db"];

const calls = (fetchMock: ReturnType<typeof setup>["fetchMock"]) =>
  fetchMock.mock.calls.map(([input, init]) => `${init?.method ?? "GET"} ${String(input)}`);
const path = (db: TestDb) => db.read(locationState.get(LOCATION_ID))?.path;

/** What pressing a game's card and then "Create game" does. */
const startCreating = (db: TestDb) => {
  db.ops.lobby.openNewGame({ kind: "long-backgammon" });
  db.ops.lobby.createGame();
};

/** The fake server, except that it can't make a game. */
const failingToCreate = () => {
  const server = fakeServer();
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    String(input) === "/api/games" && init?.method === "POST"
      ? new Response(null, { status: 500 })
      : server.fetchImpl(input, init);
};

afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
  vi.unstubAllGlobals();
});

describe("creating a game", () => {
  it("asks the server for a game of the kind, then opens its page", async () => {
    const { db, fetchMock, pushState } = setup();

    startCreating(db);
    expect(db.read(newGame.get(NEW_GAME_ID))).toMatchObject({ state: "creating" });
    await settle();

    const id = gameIdOf(1);
    expect(calls(fetchMock)).toContain("POST /api/games");
    const post = fetchMock.mock.calls.find(([input]) => String(input) === "/api/games");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ kind: "long-backgammon" });
    expect(pushState).toHaveBeenCalledWith(null, "", `/games/long-backgammon/${id}`);
    expect(path(db)).toBe(`/games/long-backgammon/${id}`);
    expect(db.read(newGame.get(NEW_GAME_ID))).toBeUndefined();
  });

  it("creates one game, however often the button is pressed", async () => {
    const { db, server } = setup();

    startCreating(db);
    startCreating(db);
    await settle();

    expect(server.games.size).toBe(1);
  });

  it("waits for the session, and is sent again with a new token after a 401", async () => {
    const { db, server } = setup();
    await settle();
    server.users.clear(); // the server forgot us

    startCreating(db);
    await settle();

    expect([...server.games.values()].map((g) => g.players)).toEqual([[issued(2).userId]]);
    expect(path(db)).toBe(`/games/long-backgammon/${gameIdOf(1)}`);
  });

  it("keeps the reason when it fails, stays where it is, and can be tried again", async () => {
    let fail = true;
    const server = fakeServer();
    const { db, pushState } = setup(async (input, init) => {
      if (fail && String(input) === "/api/games") return new Response(null, { status: 500 });
      return server.fetchImpl(input, init);
    });

    startCreating(db);
    await settle();
    expect(db.read(newGame.get(NEW_GAME_ID))).toMatchObject({ state: "failed", error: "Error: HTTP 500" });
    expect(pushState).not.toHaveBeenCalled();

    fail = false;
    db.ops.lobby.createGame();
    await settle();
    expect(db.read(newGame.get(NEW_GAME_ID))).toBeUndefined();
    expect(path(db)).toBe(`/games/long-backgammon/${gameIdOf(1)}`);
  });
});

describe("the dialog for creating a game", () => {
  const row = (db: TestDb) => db.read(newGame.get(NEW_GAME_ID));

  it("opens for the game that was picked, and closes without creating anything", async () => {
    const { db, server, fetchMock } = setup();
    await settle();

    db.ops.lobby.openNewGame({ kind: "long-backgammon" });
    expect(row(db)).toEqual({
      id: NEW_GAME_ID,
      state: "choosing",
      kind: "long-backgammon",
      error: null,
    });
    await settle();
    db.ops.lobby.closeNewGame();

    expect(row(db)).toBeUndefined();
    expect(server.games.size).toBe(0);
    expect(calls(fetchMock)).not.toContain("POST /api/games");
  });

  it("does nothing when asked to create with no dialog open", async () => {
    const { db, server } = setup();

    db.ops.lobby.createGame();
    await settle();

    expect(row(db)).toBeUndefined();
    expect(server.games.size).toBe(0);
  });

  it("can't be closed or reopened while the game is being made", async () => {
    const { db } = setup();
    startCreating(db);

    db.ops.lobby.closeNewGame();
    db.ops.lobby.openNewGame({ kind: "chess" });

    expect(row(db)).toMatchObject({ state: "creating", kind: "long-backgammon" });
  });

  it("stays open with the reason when the game can't be made, and can be closed", async () => {
    const { db } = setup(failingToCreate());
    startCreating(db);
    await settle();
    expect(row(db)).toMatchObject({ state: "failed", error: "Error: HTTP 500" });

    db.ops.lobby.closeNewGame();

    expect(row(db)).toBeUndefined();
  });

  it("starts afresh when it is opened again after a failure", async () => {
    const { db } = setup(failingToCreate());
    startCreating(db);
    await settle();
    db.ops.lobby.closeNewGame();

    db.ops.lobby.openNewGame({ kind: "long-backgammon" });

    expect(row(db)).toMatchObject({ state: "choosing", error: null });
  });
});

describe("your games", () => {
  const mine = (n: number, others: string[] = []) => ({
    id: gameIdOf(n),
    kind: "long-backgammon",
    players: [issued(1).userId, ...others],
  });

  it("lists the games you are in, with their state", async () => {
    const { db, server } = setup();
    await settle(); // registers as user-1
    server.addGame({ ...mine(1), updatedAt: 10 });
    server.addGame({ ...mine(2, ["rival"]), updatedAt: 20 });
    server.addGame({ id: gameIdOf(3), kind: "long-backgammon", players: ["stranger"] });

    db.ops.lobby.loadGames();
    expect(db.read(gamesList.get(GAMES_LIST_ID))?.state).toBe("loading");
    await settle();

    expect(db.read(gamesList.get(GAMES_LIST_ID))).toMatchObject({ state: "loaded", error: null });
    const rows = [...db.read(myGames.all())].sort((a, b) => a.updatedAt - b.updatedAt);
    expect(rows).toEqual([
      { gameId: gameIdOf(1), kind: "long-backgammon", seat: 0, joined: 1, started: false, updatedAt: 10 },
      { gameId: gameIdOf(2), kind: "long-backgammon", seat: 0, joined: 2, started: true, updatedAt: 20 },
    ]);
  });

  it("lists games of every kind oldest first by the index, so the page needs no sort", async () => {
    const { db, server } = setup();
    await settle();
    // The ids are in the opposite order to the times, so only the index can put them right.
    server.addGame({ ...mine(1), updatedAt: 30 });
    server.addGame({ ...mine(2), kind: "chess", updatedAt: 10 });
    server.addGame({ ...mine(3), updatedAt: 20 });

    db.ops.lobby.loadGames();
    await settle();

    const listed = db.read(myGames.byUpdated.updatedAtGte(0));
    expect(listed.map((game) => game.gameId)).toEqual([gameIdOf(2), gameIdOf(3), gameIdOf(1)]);
    expect(listed.map((game) => game.kind)).toEqual(["chess", "long-backgammon", "long-backgammon"]);

    // A game that changes moves to the end, and the index follows.
    server.addGame({ ...mine(2), kind: "chess", updatedAt: 40 });
    db.ops.lobby.loadGames();
    await settle();
    const after = db.read(myGames.byUpdated.updatedAtGte(0));
    expect(after.map((game) => game.gameId)).toEqual([gameIdOf(3), gameIdOf(1), gameIdOf(2)]);
  });

  it("drops a game the server no longer lists when it is read again", async () => {
    const { db, server } = setup();
    await settle();
    server.addGame(mine(1));
    server.addGame(mine(2));
    db.ops.lobby.loadGames();
    await settle();

    server.games.delete(gameIdOf(1));
    db.ops.lobby.loadGames();
    await settle();

    expect(db.read(myGames.all()).map((g) => g.gameId)).toEqual([gameIdOf(2)]);
  });

  it("keeps the games it has when a read fails, and says so", async () => {
    let fail = false;
    const server = fakeServer();
    const { db } = setup(async (input, init) => {
      if (fail && String(input) === "/api/games") throw new TypeError("network down");
      return server.fetchImpl(input, init);
    });
    await settle();
    server.addGame(mine(1));
    db.ops.lobby.loadGames();
    await settle();

    fail = true;
    db.ops.lobby.loadGames();
    await settle();

    expect(db.read(gamesList.get(GAMES_LIST_ID))).toMatchObject({
      state: "failed",
      error: "TypeError: network down",
    });
    expect(db.read(myGames.all())).toHaveLength(1);
  });
});
