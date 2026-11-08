import { createDb } from "millpond";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeServer, fakeStorage, issued, json, settle } from "../../testing";
import { SESSION_ID, apiFetch, loadCredentials, session, sessionState } from "../session";
import { STORAGE_KEY } from "../session/credentials";
import { PROFILE_ID, profile, profileState } from "./index";

const FRESH = issued(1);
const OLD = { userId: "user-old", accessToken: "token-old" };

// A fresh db per test, from the same features the app uses.
const dbs: { dispose(): void }[] = [];
function setup(fetchImpl: typeof fetch, storage = fakeStorage()) {
  const fetchMock = vi.fn(fetchImpl);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("localStorage", storage);
  const db = createDb({ features: { session, profile } });
  dbs.push(db);
  return { db, fetchMock, storage };
}
type TestDb = ReturnType<typeof setup>["db"];

/** A visit by someone the server remembers as "Ada", with a token from an earlier visit. */
function returningAda() {
  const server = fakeServer();
  server.addUser(OLD, "Ada");
  const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify(OLD) });
  return { server, ...setup(server.fetchImpl, storage) };
}

/** What `main.tsx` does at startup. */
const start = (db: TestDb) => db.ops.session.startSession({ stored: loadCredentials() });

const profileRow = (db: TestDb) => db.read(profileState.get(PROFILE_ID));
const sessionRow = (db: TestDb) => db.read(sessionState.get(SESSION_ID));

const calls = (fetchMock: ReturnType<typeof setup>["fetchMock"]) =>
  fetchMock.mock.calls.map(([input, init]) => `${init?.method ?? "GET"} ${String(input)}`);

afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
  vi.unstubAllGlobals();
});

describe("loading the name", () => {
  it("is loading until the server answers", async () => {
    const { db } = returningAda();

    start(db);
    await Promise.resolve(); // the flush that starts the load
    expect(profileRow(db)).toMatchObject({ state: "loading", name: null });

    await settle();
    expect(profileRow(db)).toMatchObject({ state: "idle", name: "Ada", error: null });
  });

  it("finds no name for a new visitor, once it has registered", async () => {
    const { db, fetchMock } = setup(fakeServer().fetchImpl);

    start(db);
    await settle();

    expect(profileRow(db)).toMatchObject({ state: "idle", name: null, error: null });
    expect(calls(fetchMock)).toEqual(["POST /api/register", "GET /api/me"]);
  });

  it("sends the stored token, without registering", async () => {
    const { db, fetchMock } = returningAda();

    start(db);
    await settle();

    expect(calls(fetchMock)).toEqual(["GET /api/me"]);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${OLD.accessToken}`);
  });

  it("registers a new user when the server doesn't know the stored token", async () => {
    const server = fakeServer(); // has never heard of OLD
    const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify(OLD) });
    const { db, fetchMock } = setup(server.fetchImpl, storage);

    start(db);
    await settle();

    expect(sessionRow(db)).toMatchObject({ state: "ready", ...FRESH });
    expect(JSON.parse(storage.data.get(STORAGE_KEY) ?? "null")).toEqual(FRESH);
    expect(profileRow(db)).toMatchObject({ state: "idle", name: null, error: null });
    expect(calls(fetchMock)).toEqual(["GET /api/me", "POST /api/register", "GET /api/me"]);
  });

  it("keeps the token and reports the error when the server is down", async () => {
    const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify(OLD) });
    const { db, fetchMock } = setup(async () => {
      throw new TypeError("network down");
    }, storage);

    start(db);
    await settle();

    expect(profileRow(db)).toMatchObject({
      state: "idle",
      name: null,
      error: "TypeError: network down",
    });
    expect(sessionRow(db)).toMatchObject({ state: "ready", ...OLD });
    expect(calls(fetchMock)).toEqual(["GET /api/me"]);
  });

  it("drops the old user's name when the session registers a new user", async () => {
    const { db, server } = returningAda();
    start(db);
    await settle();
    expect(profileRow(db)?.name).toBe("Ada");

    server.users.clear(); // the server loses its users; the next authenticated call finds out
    await apiFetch({ db, run: db.run.bind(db) }, "/api/games");
    await settle();

    expect(sessionRow(db)).toMatchObject({ state: "ready", ...FRESH });
    expect(profileRow(db)).toMatchObject({ state: "idle", name: null });
  });
});

describe("setting the name", () => {
  /** A returning visitor whose name has loaded. */
  async function loadedAda() {
    const env = returningAda();
    start(env.db);
    await settle();
    env.fetchMock.mockClear();
    return env;
  }

  it("saves the trimmed name on the server, and shows it", async () => {
    const { db, server, fetchMock } = await loadedAda();

    db.ops.profile.setName({ name: "  Grace  " });
    expect(profileRow(db)).toMatchObject({ state: "saving", pending: "Grace", name: "Ada" });

    await settle();
    expect(profileRow(db)).toEqual({
      id: PROFILE_ID,
      state: "idle",
      name: "Grace",
      pending: null,
      error: null,
    });
    expect(server.users.get(OLD.accessToken)?.name).toBe("Grace");

    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/api/me");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Grace" });
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${OLD.accessToken}`);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("keeps the old name and shows the reason when the server rejects the new one", async () => {
    const { db, server } = await loadedAda();

    db.ops.profile.setName({ name: "x".repeat(33) });
    await settle();

    expect(profileRow(db)).toMatchObject({ state: "idle", name: "Ada", pending: null });
    expect(profileRow(db)?.error).toContain("name must be 1 to 32 characters");
    expect(server.users.get(OLD.accessToken)?.name).toBe("Ada");
  });

  it("keeps the old name when the server can't be reached, and can be tried again", async () => {
    const server = fakeServer();
    server.addUser(OLD, "Ada");
    let up = true;
    const { db } = setup(
      async (input, init) => {
        if (!up) throw new TypeError("network down");
        return server.fetchImpl(input, init);
      },
      fakeStorage({ [STORAGE_KEY]: JSON.stringify(OLD) }),
    );
    start(db);
    await settle();

    up = false;
    db.ops.profile.setName({ name: "Grace" });
    await settle();
    expect(profileRow(db)).toMatchObject({
      state: "idle",
      name: "Ada",
      error: "TypeError: network down",
    });

    up = true;
    db.ops.profile.setName({ name: "Grace" });
    expect(profileRow(db)?.error).toBeNull();
    await settle();
    expect(profileRow(db)).toMatchObject({ state: "idle", name: "Grace", error: null });
  });

  it("sends one request when asked twice", async () => {
    const { db, fetchMock } = await loadedAda();

    db.ops.profile.setName({ name: "Grace" });
    await Promise.resolve(); // the flush that starts the save
    db.ops.profile.setName({ name: "Hopper" });
    await settle();

    expect(calls(fetchMock)).toEqual(["PATCH /api/me"]);
    expect(profileRow(db)?.name).toBe("Grace");
  });

  it("ignores a blank name", async () => {
    const { db, fetchMock } = await loadedAda();

    db.ops.profile.setName({ name: "   " });
    await settle();

    expect(profileRow(db)).toMatchObject({ state: "idle", name: "Ada" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a name set before the current one has loaded", async () => {
    const { db, fetchMock } = returningAda();

    db.ops.profile.setName({ name: "Grace" }); // no profile row yet
    start(db);
    await Promise.resolve();
    db.ops.profile.setName({ name: "Grace" }); // still loading
    await settle();

    expect(profileRow(db)).toMatchObject({ state: "idle", name: "Ada" });
    expect(calls(fetchMock)).toEqual(["GET /api/me"]);
  });

  it("registers a new user and saves the name for them, when the server lost the old one", async () => {
    const { db, server, fetchMock } = await loadedAda();
    server.users.clear();

    db.ops.profile.setName({ name: "Grace" });
    await settle();

    expect(sessionRow(db)).toMatchObject({ state: "ready", ...FRESH });
    expect(profileRow(db)).toMatchObject({ state: "idle", name: "Grace", error: null });
    expect(server.users.get(FRESH.accessToken)?.name).toBe("Grace");
    expect(calls(fetchMock)).toEqual([
      "PATCH /api/me", // 401
      "POST /api/register",
      "GET /api/me",
      "PATCH /api/me",
    ]);
  });
});

describe("without a session", () => {
  it("never calls the server while registration is failing", async () => {
    const { db, fetchMock } = setup(async () => json({}, 500));

    start(db);
    await settle();
    db.ops.profile.setName({ name: "Grace" });
    await settle();

    expect(sessionRow(db)?.state).toBe("failed");
    expect(profileRow(db)).toBeUndefined();
    expect(calls(fetchMock)).toEqual(["POST /api/register"]);
  });
});
