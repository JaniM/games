import { createDb } from "millpond";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeServer, fakeStorage, issued, json, settle } from "../../testing";
import { STORAGE_KEY, loadCredentials } from "./credentials";
import { SESSION_ID, apiFetch, session, sessionState } from "./index";

const FRESH = issued(1);
const OLD = { userId: "user-old", accessToken: "token-old" };

// A fresh db per test, from the same feature the app uses.
const dbs: { dispose(): void }[] = [];
function setup(fetchImpl: typeof fetch, storage = fakeStorage()) {
  const fetchMock = vi.fn(fetchImpl);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("localStorage", storage);
  const db = createDb({ features: { session } });
  dbs.push(db);
  return { db, fetchMock, storage };
}
type TestDb = ReturnType<typeof setup>["db"];

/** What `main.tsx` does at startup. */
const start = (db: TestDb) => db.ops.session.startSession({ stored: loadCredentials() });

const row = (db: TestDb) => db.read(sessionState.get(SESSION_ID));

/** The context an effect task would pass to `apiFetch`. */
const taskContext = (db: TestDb) => ({ db, run: db.run.bind(db) });

const paths = (fetchMock: ReturnType<typeof setup>["fetchMock"]) =>
  fetchMock.mock.calls.map(([input]) => String(input));

afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
  vi.unstubAllGlobals();
});

describe("first visit", () => {
  it("registers once, then holds the credentials", async () => {
    const { db, fetchMock } = setup(fakeServer().fetchImpl);

    start(db);
    expect(row(db)).toMatchObject({ state: "registering", accessToken: null });

    await settle();
    expect(row(db)).toEqual({ id: SESSION_ID, state: "ready", error: null, ...FRESH });
    expect(paths(fetchMock)).toEqual(["/api/register"]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("saves the credentials to local storage", async () => {
    const { db, storage } = setup(fakeServer().fetchImpl);

    start(db);
    await settle();

    expect(JSON.parse(storage.data.get(STORAGE_KEY) ?? "null")).toEqual(FRESH);
  });

  it("does not register a second time while the first is running", async () => {
    const { db, fetchMock } = setup(fakeServer().fetchImpl);

    start(db);
    await Promise.resolve(); // the flush that starts the registration task
    expect(fetchMock).toHaveBeenCalledTimes(1);
    start(db); // e.g. a second call while the request is in flight
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(row(db)?.accessToken).toBe(FRESH.accessToken);
  });

  it("still works when local storage refuses the write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = setup(fakeServer().fetchImpl, fakeStorage({}, true));

    start(db);
    await settle();

    expect(row(db)).toMatchObject({ state: "ready", ...FRESH });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("returning visit", () => {
  const stored = () => fakeStorage({ [STORAGE_KEY]: JSON.stringify(OLD) });

  it("reuses the stored token without calling the server", async () => {
    const { db, fetchMock } = setup(fakeServer().fetchImpl, stored());

    start(db);
    await settle();

    expect(row(db)).toMatchObject({ state: "ready", ...OLD });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the token it has in memory", async () => {
    const { db, fetchMock } = setup(fakeServer().fetchImpl, stored());

    start(db);
    db.ops.session.startSession({ stored: FRESH });
    await settle();

    expect(row(db)).toMatchObject({ state: "ready", ...OLD });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["is not JSON", "{oops"],
    ["lacks the token", JSON.stringify({ userId: "user-old" })],
    ["has an empty token", JSON.stringify({ userId: "user-old", accessToken: "" })],
  ])("registers anew when the stored value %s", async (_, value) => {
    const { db } = setup(fakeServer().fetchImpl, fakeStorage({ [STORAGE_KEY]: value }));

    start(db);
    await settle();

    expect(row(db)).toMatchObject({ state: "ready", ...FRESH });
  });

  it("registers anew when local storage can't be read", async () => {
    const storage = {
      ...fakeStorage(),
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    const { db } = setup(fakeServer().fetchImpl, storage);

    start(db);
    await settle();

    expect(row(db)).toMatchObject({ state: "ready", ...FRESH });
  });
});

describe("failed registration", () => {
  const failing = (status: number) => async () => json({}, status);

  it("is failed with the HTTP status, and saves nothing", async () => {
    const { db, storage } = setup(failing(500));

    start(db);
    await settle();

    expect(row(db)).toMatchObject({ state: "failed", accessToken: null, error: "Error: HTTP 500" });
    expect(storage.data.size).toBe(0);
  });

  it("is failed when the reply has no access token", async () => {
    const { db, storage } = setup(async () => json({ userId: "user-1" }, 201));

    start(db);
    await settle();

    expect(row(db)?.state).toBe("failed");
    expect(storage.data.size).toBe(0);
  });

  it("is failed on a network error, and starting again retries", async () => {
    const server = fakeServer();
    let up = false;
    const { db, fetchMock } = setup(async (input, init) => {
      if (!up) throw new TypeError("network down");
      return server.fetchImpl(input, init);
    });

    start(db);
    await settle();
    expect(row(db)).toMatchObject({ state: "failed", error: "TypeError: network down" });

    up = true;
    start(db);
    await settle();
    expect(row(db)).toMatchObject({ state: "ready", error: null, ...FRESH });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("apiFetch", () => {
  /** A ready session holding a token the server knows. */
  async function readySession() {
    const server = fakeServer();
    const env = setup(server.fetchImpl);
    start(env.db);
    await settle();
    env.fetchMock.mockClear();
    return { ...env, server };
  }

  it("sends the access token and leaves the rest of the request alone", async () => {
    const { db, fetchMock } = await readySession();

    const res = await apiFetch(taskContext(db), "/api/me", {
      method: "PUT",
      headers: { "X-Test": "1" },
    });

    expect(res.status).toBe(200);
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/api/me");
    expect(init?.method).toBe("PUT");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${FRESH.accessToken}`);
    expect(headers.get("X-Test")).toBe("1");
  });

  it("refuses to send a request before there is a token", async () => {
    const { db, fetchMock } = setup(fakeServer().fetchImpl);

    await expect(apiFetch(taskContext(db), "/api/me")).rejects.toThrow("no access token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("when the server doesn't know the token", () => {
    it("registers a new user and uses the new token from then on", async () => {
      const { db, fetchMock, storage, server } = await readySession();
      server.users.clear(); // the server lost our user, e.g. its database was reset

      const res = await apiFetch(taskContext(db), "/api/me");
      expect(res.status).toBe(401);
      expect(row(db)).toMatchObject({ state: "registering", accessToken: null });

      await settle();
      expect(row(db)).toMatchObject({ state: "ready", ...issued(2) });
      expect(JSON.parse(storage.data.get(STORAGE_KEY) ?? "null")).toEqual(issued(2));

      fetchMock.mockClear();
      expect((await apiFetch(taskContext(db), "/api/me")).status).toBe(200);
      expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
        `Bearer ${issued(2).accessToken}`,
      );
    });

    it("registers only once for requests that fail together", async () => {
      const { db, fetchMock, server } = await readySession();
      server.users.clear();

      await Promise.all([
        apiFetch(taskContext(db), "/api/me"),
        apiFetch(taskContext(db), "/api/me"),
        apiFetch(taskContext(db), "/api/me"),
      ]);
      await settle();

      expect(paths(fetchMock).filter((path) => path === "/api/register")).toHaveLength(1);
      expect(row(db)).toMatchObject({ state: "ready", ...issued(2) });
    });

    it("replaces a stale stored token", async () => {
      const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify(OLD) });
      const { db } = setup(fakeServer().fetchImpl, storage);

      start(db);
      expect(row(db)).toMatchObject({ state: "ready", ...OLD });
      await apiFetch(taskContext(db), "/api/me");
      await settle();

      expect(row(db)).toMatchObject({ state: "ready", ...FRESH });
      expect(JSON.parse(storage.data.get(STORAGE_KEY) ?? "null")).toEqual(FRESH);
    });

    it("ends as failed, with no token, if the new registration doesn't work", async () => {
      const { db } = setup(async (input) =>
        String(input) === "/api/register" ? json({}, 503) : new Response(null, { status: 401 }),
      );
      db.ops.session.startSession({ stored: OLD });

      await apiFetch(taskContext(db), "/api/me");
      await settle();

      expect(row(db)).toMatchObject({ state: "failed", accessToken: null });
    });
  });

  it.each([403, 404, 500, 503])("keeps the token on a %i", async (status) => {
    const { db, fetchMock } = setup(async () => new Response(null, { status }));
    db.ops.session.startSession({ stored: OLD });

    const res = await apiFetch(taskContext(db), "/api/me");
    await settle();

    expect(res.status).toBe(status);
    expect(row(db)).toMatchObject({ state: "ready", ...OLD });
    expect(paths(fetchMock)).toEqual(["/api/me"]);
  });

  it("keeps the token when the server can't be reached", async () => {
    const { db } = setup(async () => {
      throw new TypeError("network down");
    });
    db.ops.session.startSession({ stored: OLD });

    await expect(apiFetch(taskContext(db), "/api/me")).rejects.toThrow("network down");

    expect(row(db)).toMatchObject({ state: "ready", ...OLD });
  });
});
