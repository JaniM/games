import { createDb } from "millpond";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOT_USER_ID, BOT_USER_IDS, fakeServer, fakeStorage, gameIdOf, issued, settle } from "../../testing";
import { LOCATION_ID, locationState, router } from "../router";
import { session } from "../session";
import {
  GAMES_LIST_ID,
  LOBBY_SETTINGS_ID,
  NEW_GAME_ID,
  PUBLIC_LIST_ID,
  gamesList,
  lobby,
  lobbySettings,
  loadPublic,
  myGames,
  newGame,
  publicGames,
  publicList,
} from "./index";

// A fresh db per test, from the same features the app uses.
const dbs: { dispose(): void }[] = [];
function setup(fetchImpl?: typeof fetch) {
  const server = fakeServer();
  const fetchMock = vi.fn(fetchImpl ?? server.fetchImpl);
  const pushState = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const storage = fakeStorage();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("history", { pushState });
  const db = createDb({ features: { session, router, lobby } });
  dbs.push(db);
  db.ops.session.startSession({ stored: null });
  return { db, server, fetchMock, pushState, storage };
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
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ kind: "long-backgammon", bot: false, public: true });
    expect(pushState).toHaveBeenCalledWith(null, "", `/games/${id}`);
    expect(path(db)).toBe(`/games/${id}`);
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
    expect(path(db)).toBe(`/games/${gameIdOf(1)}`);
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
    expect(path(db)).toBe(`/games/${gameIdOf(1)}`);
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
      bot: false,
      level: "medium",
      public: true,
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
    db.ops.lobby.chooseOpponent({ bot: true });
    db.ops.lobby.closeNewGame();

    db.ops.lobby.openNewGame({ kind: "long-backgammon" });

    expect(row(db)).toMatchObject({ state: "choosing", error: null, bot: false });
  });
});

describe("choosing the opponent", () => {
  const row = (db: TestDb) => db.read(newGame.get(NEW_GAME_ID));

  it("is a friend until the bot is picked, and can be changed back", () => {
    const { db } = setup();
    db.ops.lobby.openNewGame({ kind: "long-backgammon" });
    expect(row(db)?.bot).toBe(false);

    db.ops.lobby.chooseOpponent({ bot: true });
    expect(row(db)?.bot).toBe(true);

    db.ops.lobby.chooseOpponent({ bot: false });
    expect(row(db)?.bot).toBe(false);
  });

  it("asks the server for a game against the bot, which has begun when the page opens", async () => {
    const { db, server, fetchMock } = setup();
    db.ops.lobby.openNewGame({ kind: "long-backgammon" });
    db.ops.lobby.chooseOpponent({ bot: true });

    db.ops.lobby.createGame();
    await settle();

    const post = fetchMock.mock.calls.find(([input]) => String(input) === "/api/games");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      kind: "long-backgammon",
      bot: true,
      level: "medium",
      public: true,
    });
    const [created] = [...server.games.values()];
    expect(created?.players).toHaveLength(2);
    expect(path(db)).toBe(`/games/${gameIdOf(1)}`);
  });

  it("does nothing with no dialog open", () => {
    const { db } = setup();

    db.ops.lobby.chooseOpponent({ bot: true });

    expect(row(db)).toBeUndefined();
  });

  it("can't change while the game is being made: the request has gone out as it was", async () => {
    const { db } = setup();
    startCreating(db);

    db.ops.lobby.chooseOpponent({ bot: true });

    expect(row(db)).toMatchObject({ state: "creating", bot: false });
  });
});

describe("choosing the level of the bot", () => {
  const row = (db: TestDb) => db.read(newGame.get(NEW_GAME_ID));
  const body = (fetchMock: ReturnType<typeof setup>["fetchMock"]) => {
    const post = fetchMock.mock.calls.find(([input]) => String(input) === "/api/games");
    return JSON.parse(String(post?.[1]?.body));
  };

  it("is medium until another is picked, and can be changed again", () => {
    const { db } = setup();
    db.ops.lobby.openNewGame({ kind: "long-backgammon" });
    expect(row(db)?.level).toBe("medium");

    db.ops.lobby.chooseLevel({ level: "hard" });
    expect(row(db)?.level).toBe("hard");

    db.ops.lobby.chooseLevel({ level: "easy" });
    expect(row(db)?.level).toBe("easy");
  });

  it("starts again at medium when the dialog is opened again", () => {
    const { db } = setup();
    db.ops.lobby.openNewGame({ kind: "long-backgammon" });
    db.ops.lobby.chooseLevel({ level: "hard" });
    db.ops.lobby.closeNewGame();

    db.ops.lobby.openNewGame({ kind: "long-backgammon" });

    expect(row(db)?.level).toBe("medium");
  });

  it("asks the server for a bot of the level that was picked, which sits in the other seat", async () => {
    const { db, server, fetchMock } = setup();
    db.ops.lobby.openNewGame({ kind: "ultimate-tic-tac-toe" });
    db.ops.lobby.chooseOpponent({ bot: true });
    db.ops.lobby.chooseLevel({ level: "hard" });

    db.ops.lobby.createGame();
    await settle();

    expect(body(fetchMock)).toEqual({
      kind: "ultimate-tic-tac-toe",
      bot: true,
      level: "hard",
      public: true,
    });
    const [created] = [...server.games.values()];
    expect(created?.players[1]).toBe(BOT_USER_IDS.hard);
  });

  it("sends no level for a friend, even if one was picked before going back to a friend", async () => {
    const { db, server, fetchMock } = setup();
    db.ops.lobby.openNewGame({ kind: "long-backgammon" });
    db.ops.lobby.chooseOpponent({ bot: true });
    db.ops.lobby.chooseLevel({ level: "easy" });
    db.ops.lobby.chooseOpponent({ bot: false });

    db.ops.lobby.createGame();
    await settle();

    expect(body(fetchMock)).toEqual({ kind: "long-backgammon", bot: false, public: true });
    const [created] = [...server.games.values()];
    expect(created?.players).toHaveLength(1);
  });

  it("remembers the level when the bot is dropped and picked again", () => {
    const { db } = setup();
    db.ops.lobby.openNewGame({ kind: "long-backgammon" });
    db.ops.lobby.chooseOpponent({ bot: true });
    db.ops.lobby.chooseLevel({ level: "hard" });

    db.ops.lobby.chooseOpponent({ bot: false });
    db.ops.lobby.chooseOpponent({ bot: true });

    expect(row(db)).toMatchObject({ bot: true, level: "hard" });
  });

  it("does nothing with no dialog open", () => {
    const { db } = setup();

    db.ops.lobby.chooseLevel({ level: "hard" });

    expect(row(db)).toBeUndefined();
  });

  it("can't change while the game is being made: the request has gone out as it was", async () => {
    const { db } = setup();
    startCreating(db);

    db.ops.lobby.chooseLevel({ level: "hard" });

    expect(row(db)).toMatchObject({ state: "creating", level: "medium" });
  });
});

describe("choosing whether the game is public", () => {
  const row = (db: TestDb) => db.read(newGame.get(NEW_GAME_ID));
  const body = (fetchMock: ReturnType<typeof setup>["fetchMock"]) => {
    const post = fetchMock.mock.calls.find(([input]) => String(input) === "/api/games");
    return JSON.parse(String(post?.[1]?.body));
  };

  it("is public until it is unticked, and can be changed back", () => {
    const { db } = setup();
    db.ops.lobby.openNewGame({ kind: "long-backgammon" });
    expect(row(db)?.public).toBe(true);

    db.ops.lobby.choosePublic({ public: false });
    expect(row(db)?.public).toBe(false);

    db.ops.lobby.choosePublic({ public: true });
    expect(row(db)?.public).toBe(true);
  });

  it("asks the server for a private game when it was unticked, and the game is private there", async () => {
    const { db, server, fetchMock } = setup();
    db.ops.lobby.openNewGame({ kind: "long-backgammon" });
    db.ops.lobby.choosePublic({ public: false });

    db.ops.lobby.createGame();
    await settle();

    expect(body(fetchMock)).toEqual({ kind: "long-backgammon", bot: false, public: false });
    expect([...server.games.values()].map((game) => game.public)).toEqual([false]);
  });

  it("asks for a public game as it does for any, against the bot too", async () => {
    const { db, server, fetchMock } = setup();
    db.ops.lobby.openNewGame({ kind: "long-backgammon" });
    db.ops.lobby.chooseOpponent({ bot: true });

    db.ops.lobby.createGame();
    await settle();

    expect(body(fetchMock)).toEqual({ kind: "long-backgammon", bot: true, level: "medium", public: true });
    expect([...server.games.values()].map((game) => game.public)).toEqual([true]);
  });

  it("does nothing with no dialog open, and leaves what was remembered alone", () => {
    const { db } = setup();
    db.ops.lobby.startLobby({ stored: null });

    db.ops.lobby.choosePublic({ public: false });

    expect(row(db)).toBeUndefined();
    expect(db.read(lobbySettings.get(LOBBY_SETTINGS_ID))?.public).toBe(true);
  });

  it("can't change while the game is being made: the request has gone out as it was", async () => {
    const { db } = setup();
    db.ops.lobby.startLobby({ stored: null });
    startCreating(db);

    db.ops.lobby.choosePublic({ public: false });

    expect(row(db)).toMatchObject({ state: "creating", public: true });
    expect(db.read(lobbySettings.get(LOBBY_SETTINGS_ID))?.public).toBe(true);
  });

  describe("remembered between games and visits", () => {
    it("is what the next dialog starts with, after a game was made or the dialog was closed", async () => {
      const { db } = setup();
      db.ops.lobby.startLobby({ stored: null });
      db.ops.lobby.openNewGame({ kind: "long-backgammon" });
      db.ops.lobby.choosePublic({ public: false });
      db.ops.lobby.closeNewGame();

      db.ops.lobby.openNewGame({ kind: "long-backgammon" });
      expect(row(db)?.public).toBe(false);

      db.ops.lobby.createGame();
      await settle();
      db.ops.lobby.openNewGame({ kind: "long-backgammon" });
      expect(row(db)?.public).toBe(false);
    });

    it("is saved to local storage as soon as it is chosen", async () => {
      const { db, storage } = setup();
      db.ops.lobby.startLobby({ stored: null });
      db.ops.lobby.openNewGame({ kind: "long-backgammon" });

      db.ops.lobby.choosePublic({ public: false });
      await settle();

      expect(storage.data.get("games.public")).toBe("false");
      expect(loadPublic()).toBe(false);

      db.ops.lobby.choosePublic({ public: true });
      await settle();
      expect(loadPublic()).toBe(true);
    });

    it("starts the dialog as the last visit left it", () => {
      const { db } = setup();
      db.ops.lobby.startLobby({ stored: false });

      db.ops.lobby.openNewGame({ kind: "long-backgammon" });

      expect(row(db)?.public).toBe(false);
    });

    it("is public when the last visit left nothing", () => {
      const { db } = setup();
      db.ops.lobby.startLobby({ stored: null });

      db.ops.lobby.openNewGame({ kind: "long-backgammon" });

      expect(row(db)?.public).toBe(true);
    });

    it("is public before startLobby has run", () => {
      const { db } = setup();

      db.ops.lobby.openNewGame({ kind: "long-backgammon" });

      expect(row(db)?.public).toBe(true);
    });

    it("is not undone by startLobby running after a choice was made", () => {
      const { db } = setup();
      db.ops.lobby.openNewGame({ kind: "long-backgammon" });
      db.ops.lobby.choosePublic({ public: false });

      db.ops.lobby.startLobby({ stored: true });

      expect(db.read(lobbySettings.get(LOBBY_SETTINGS_ID))?.public).toBe(false);
    });

    it("keeps working for this visit when local storage can't be written", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { db } = setup();
      vi.stubGlobal("localStorage", fakeStorage({}, true));
      db.ops.lobby.startLobby({ stored: null });
      db.ops.lobby.openNewGame({ kind: "long-backgammon" });

      db.ops.lobby.choosePublic({ public: false });
      await settle();
      db.ops.lobby.closeNewGame();
      db.ops.lobby.openNewGame({ kind: "long-backgammon" });

      expect(row(db)?.public).toBe(false);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});

describe("reading the choice a visit left in local storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["true", true],
    ["false", false],
  ])("reads %s", (raw, expected) => {
    vi.stubGlobal("localStorage", fakeStorage({ "games.public": raw }));

    expect(loadPublic()).toBe(expected);
  });

  it.each([[""], ["yes"], ["1"], ["TRUE"], ["null"]])("takes %j for no choice", (raw) => {
    vi.stubGlobal("localStorage", fakeStorage({ "games.public": raw }));

    expect(loadPublic()).toBeNull();
  });

  it("takes nothing saved for no choice", () => {
    vi.stubGlobal("localStorage", fakeStorage());

    expect(loadPublic()).toBeNull();
  });

  it("takes storage the browser won't open for no choice", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    expect(loadPublic()).toBeNull();
  });
});

describe("the public list", () => {
  const listed = (n: number, overrides: Record<string, unknown> = {}) => ({
    id: gameIdOf(n),
    kind: "long-backgammon",
    players: [`one-${n}`, `two-${n}`],
    public: true,
    ...overrides,
  });

  it("lists the public games that have started, with their state and who plays", async () => {
    const { db, server } = setup();
    await settle();
    server.addUser({ userId: "ada-id", accessToken: "ada-token" }, "Ada");
    server.addGame({ ...listed(1, { players: ["ada-id", BOT_USER_ID] }), updatedAt: 10 });
    server.addGame({ ...listed(2), finished: true, updatedAt: 20 });

    db.ops.lobby.loadPublicGames();
    expect(db.read(publicList.get(PUBLIC_LIST_ID))?.state).toBe("loading");
    await settle();

    expect(db.read(publicList.get(PUBLIC_LIST_ID))).toMatchObject({ state: "loaded", error: null });
    const rows = [...db.read(publicGames.all())].sort((a, b) => a.updatedAt - b.updatedAt);
    expect(rows).toEqual([
      {
        gameId: gameIdOf(1),
        kind: "long-backgammon",
        finished: false,
        updatedAt: 10,
        playerNames: ["Ada", "Medium bot"],
        playerGuests: [true, false],
      },
      {
        gameId: gameIdOf(2),
        kind: "long-backgammon",
        finished: true,
        updatedAt: 20,
        playerNames: [null, null],
        playerGuests: [true, true],
      },
    ]);
  });

  it("leaves out games that are private, or are waiting for an opponent", async () => {
    const { db, server } = setup();
    await settle();
    server.addGame(listed(1));
    server.addGame(listed(2, { public: false }));
    server.addGame(listed(3, { players: ["alone"] }));

    db.ops.lobby.loadPublicGames();
    await settle();

    expect(db.read(publicGames.all()).map((game) => game.gameId)).toEqual([gameIdOf(1)]);
  });

  it("sends no token, so anyone can read it, with or without a session", async () => {
    const { db, server, fetchMock } = setup();
    await settle();
    server.addGame(listed(1));
    server.users.clear(); // the server has forgotten us: a call with our token would be a 401

    db.ops.lobby.loadPublicGames();
    await settle();

    const request = fetchMock.mock.calls.find(([input]) => String(input) === "/api/public-games");
    expect(new Headers(request?.[1]?.headers).has("Authorization")).toBe(false);
    expect(db.read(publicList.get(PUBLIC_LIST_ID))?.state).toBe("loaded");
    expect(db.read(publicGames.all())).toHaveLength(1);
  });

  it("is read before the browser has registered", async () => {
    const { db, server } = setup();
    server.addGame(listed(1));

    // No `settle` first: the session has not got its token yet.
    db.ops.lobby.loadPublicGames();
    await settle();

    expect(db.read(publicGames.all())).toHaveLength(1);
  });

  it("lists games oldest first by the index, so the page needs no sort", async () => {
    const { db, server } = setup();
    await settle();
    // The ids are in the opposite order to the times, so only the index can put them right.
    server.addGame({ ...listed(1), updatedAt: 30 });
    server.addGame({ ...listed(2), updatedAt: 10 });
    server.addGame({ ...listed(3), updatedAt: 20 });

    db.ops.lobby.loadPublicGames();
    await settle();

    const rows = db.read(publicGames.byUpdated.updatedAtGte(0));
    expect(rows.map((game) => game.gameId)).toEqual([gameIdOf(2), gameIdOf(3), gameIdOf(1)]);
  });

  it("drops a game the server no longer lists when it is read again", async () => {
    const { db, server } = setup();
    await settle();
    server.addGame(listed(1));
    server.addGame(listed(2));
    db.ops.lobby.loadPublicGames();
    await settle();

    server.games.delete(gameIdOf(1));
    db.ops.lobby.loadPublicGames();
    await settle();

    expect(db.read(publicGames.all()).map((game) => game.gameId)).toEqual([gameIdOf(2)]);
  });

  it("keeps the games it has when a read fails, and says why", async () => {
    let fail = false;
    const server = fakeServer();
    const { db } = setup(async (input, init) => {
      if (fail && String(input) === "/api/public-games") return new Response(null, { status: 503 });
      return server.fetchImpl(input, init);
    });
    await settle();
    server.addGame(listed(1));
    db.ops.lobby.loadPublicGames();
    await settle();

    fail = true;
    db.ops.lobby.loadPublicGames();
    await settle();

    expect(db.read(publicList.get(PUBLIC_LIST_ID))).toMatchObject({
      state: "failed",
      error: "Error: HTTP 503",
    });
    expect(db.read(publicGames.all())).toHaveLength(1);
  });

  it("fails with the reason when the server's answer is not a list", async () => {
    const { db } = setup(async () => new Response(JSON.stringify({ games: "nope" })));

    db.ops.lobby.loadPublicGames();
    await settle();

    expect(db.read(publicList.get(PUBLIC_LIST_ID))?.state).toBe("failed");
  });

  it("is not the user's own list, which it leaves alone", async () => {
    const { db, server } = setup();
    await settle();
    server.addGame(listed(1));

    db.ops.lobby.loadPublicGames();
    await settle();

    expect(db.read(myGames.all())).toEqual([]);
    expect(db.read(gamesList.get(GAMES_LIST_ID))).toBeUndefined();
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
      {
        gameId: gameIdOf(1),
        kind: "long-backgammon",
        seat: 0,
        joined: 1,
        started: false,
        finished: false,
        updatedAt: 10,
        playerNames: [null],
        playerGuests: [true],
      },
      {
        gameId: gameIdOf(2),
        kind: "long-backgammon",
        seat: 0,
        joined: 2,
        started: true,
        finished: false,
        updatedAt: 20,
        playerNames: [null, null],
        playerGuests: [true, true],
      },
    ]);
  });

  it("lists a game that has ended as finished", async () => {
    const { db, server } = setup();
    await settle(); // registers as user-1
    server.addGame({ ...mine(1, ["rival"]), updatedAt: 10 });
    server.addGame({ ...mine(2, ["rival"]), updatedAt: 20, finished: true });

    db.ops.lobby.loadGames();
    await settle();

    expect(db.read(myGames.get(gameIdOf(1)))).toMatchObject({ started: true, finished: false });
    expect(db.read(myGames.get(gameIdOf(2)))).toMatchObject({ started: true, finished: true });
  });

  it("lists who is in each game by name, in seat order", async () => {
    const { db, server } = setup();
    await settle(); // registers as user-1
    const me = server.users.get(issued(1).accessToken);
    if (me) me.name = "Ada";
    server.addUser(issued(2), "Grace");
    server.addGame({ ...mine(1, [issued(2).userId, "nameless"]), updatedAt: 10 });

    db.ops.lobby.loadGames();
    await settle();

    expect(db.read(myGames.get(gameIdOf(1)))?.playerNames).toEqual(["Ada", "Grace", null]);
  });

  it("lists which of them are guests: an account is not, the bot is not, a guest who picked 'Ada' is", async () => {
    const { db, server } = setup();
    await settle(); // registers as user-1, a guest
    const me = server.users.get(issued(1).accessToken);
    if (me) me.name = "Ada";
    const grace = server.addAccount("grace", "correct horse", issued(2));
    server.addGame({ ...mine(1, [grace.userId]), updatedAt: 10 });
    server.addGame({ id: gameIdOf(2), kind: "long-backgammon", players: [issued(1).userId, BOT_USER_ID] });

    db.ops.lobby.loadGames();
    await settle();

    expect(db.read(myGames.get(gameIdOf(1)))).toMatchObject({
      playerNames: ["Ada", "grace"],
      playerGuests: [true, false],
    });
    expect(db.read(myGames.get(gameIdOf(2)))).toMatchObject({
      playerNames: ["Ada", "Medium bot"],
      playerGuests: [true, false],
    });
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
