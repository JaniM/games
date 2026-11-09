import { createDb } from "millpond";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeServer, fakeStorage, gameIdOf, issued, settle } from "../../testing";
import { GAMES_LIST_ID, gamesList, lobby, myGames } from "../lobby";
import { PROFILE_ID, profile, profileState } from "../profile";
import { LOCATION_ID, locationState, router } from "../router";
import { SESSION_ID, apiFetch, loadCredentials, session, sessionFlags, sessionState } from "../session";
import { STORAGE_KEY } from "../session/credentials";
import { ACCOUNT_ID, account, accountRequest } from "./index";

const PASSWORD = "correct horse";
const OLD_SESSION = { userId: "user-9", accessToken: "session-old" };

// A fresh db per test, from the same features the app uses.
const dbs: { dispose(): void }[] = [];

interface Options {
  /** What the address bar says. */
  path?: string;
  fetchImpl?: (server: ReturnType<typeof fakeServer>) => typeof fetch;
}

async function setup(options: Options = {}) {
  const server = fakeServer();
  const fetchMock = vi.fn((options.fetchImpl ?? ((s) => s.fetchImpl))(server));
  const storage = fakeStorage();
  const pushState = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("location", { protocol: "http:", host: "games.test", pathname: options.path ?? "/" });
  vi.stubGlobal("history", { pushState });
  const db = createDb({ features: { session, profile, lobby, router, account } });
  dbs.push(db);
  return { db, server, fetchMock, storage, pushState };
}
type Env = Awaited<ReturnType<typeof setup>>;
type TestDb = Env["db"];

/** A browser that has opened the site as a guest, and loaded what the front page shows. */
async function asGuest(options: Options = {}) {
  const env = await setup(options);
  env.db.ops.session.startSession({ stored: null });
  env.db.ops.lobby.loadGames();
  await settle();
  env.fetchMock.mockClear();
  return env;
}

/** A browser that has opened the site with an account's session saved by an earlier visit. */
async function asAccount(options: Options = {}) {
  const env = await setup(options);
  const credentials = env.server.addAccount("ada", PASSWORD, OLD_SESSION);
  env.storage.setItem(STORAGE_KEY, JSON.stringify(credentials));
  env.db.ops.session.startSession({ stored: loadCredentials() });
  env.db.ops.lobby.loadGames();
  await settle();
  env.fetchMock.mockClear();
  return { ...env, credentials };
}

const row = (db: TestDb) => db.read(sessionState.get(SESSION_ID));
const flags = (db: TestDb) => db.read(sessionFlags.get(SESSION_ID));
const request = (db: TestDb) => db.read(accountRequest.get(ACCOUNT_ID));
const saved = (env: Env) => JSON.parse(env.storage.data.get(STORAGE_KEY) ?? "null");
const calls = (env: Env) => env.fetchMock.mock.calls.map(([input, init]) => `${init?.method ?? "GET"} ${String(input)}`);
const gamesShown = (db: TestDb) => db.read(myGames.all()).map((game) => game.gameId);

/** Fills in the open form and sends it. */
async function submit(db: TestDb, username: string, password: string) {
  db.ops.account.submitAccountForm({ username, password });
  await settle();
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
  vi.unstubAllGlobals();
});

describe("making an account", () => {
  async function creating(options: Options = {}) {
    const env = await asGuest(options);
    env.db.ops.account.openAccountForm({ form: "create" });
    return env;
  }

  it("turns the guest into an account with a session of its own, and closes the form", async () => {
    const env = await creating();

    await submit(env.db, "Ada", PASSWORD);

    expect(row(env.db)).toMatchObject({
      state: "ready",
      userId: issued(1).userId,
      accessToken: "session-1",
      username: "Ada",
    });
    expect(flags(env.db)?.upgrading).toBe(false);
    expect(request(env.db)).toBeUndefined();
    expect(calls(env)).toContain("POST /api/account");
    expect(JSON.parse(String(env.fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ username: "Ada", password: PASSWORD });
  });

  it("saves the session, with the username, and the guest token no longer works", async () => {
    const env = await creating();

    await submit(env.db, "Ada", PASSWORD);

    expect(saved(env)).toEqual({ userId: issued(1).userId, accessToken: "session-1", username: "Ada" });
    expect(env.server.users.has(issued(1).accessToken)).toBe(false);
  });

  it("keeps the page where it is: it is the same user, with the same games", async () => {
    const env = await creating({ path: `/games/${gameIdOf(1)}` });
    env.server.addGame({ id: gameIdOf(1), kind: "long-backgammon", players: [issued(1).userId] });
    env.db.ops.lobby.loadGames();
    await settle();

    await submit(env.db, "Ada", PASSWORD);

    expect(env.pushState).not.toHaveBeenCalled();
    expect(env.db.read(locationState.get(LOCATION_ID))).toBeUndefined();
    expect(gamesShown(env.db)).toEqual([gameIdOf(1)]);
  });

  describe("the form starts with", () => {
    /** A guest who has picked a name, with the form not yet open. */
    async function named(name: string | null) {
      const env = await asGuest();
      if (name !== null) {
        env.db.ops.profile.setName({ name });
        await settle();
      }
      return env;
    }

    it("the guest's current name, which the username will replace", async () => {
      const env = await named("Countess");

      env.db.ops.account.openAccountForm({ form: "create" });

      expect(request(env.db)).toMatchObject({ form: "create", state: "editing", username: "Countess" });
    });

    it("nothing for a guest who has no name", async () => {
      const env = await named(null);

      env.db.ops.account.openAccountForm({ form: "create" });

      expect(request(env.db)?.username).toBe("");
    });

    it("the name it is given, if it is given one", async () => {
      const env = await named("Countess");

      env.db.ops.account.openAccountForm({ form: "create", username: "ada" });

      expect(request(env.db)?.username).toBe("ada");
    });

    it("nothing, for the other forms: the name is not what they ask for", async () => {
      const env = await named("Countess");

      env.db.ops.account.openAccountForm({ form: "signIn" });
      expect(request(env.db)?.username).toBe("");
      env.db.ops.account.openAccountForm({ form: "delete" });
      expect(request(env.db)?.username).toBe("");
    });

    it("a name that makes an account as it is, when the guest sends the form without a change", async () => {
      const env = await named("ada_l");
      env.db.ops.account.openAccountForm({ form: "create" });

      await submit(env.db, request(env.db)?.username ?? "", PASSWORD);

      expect(row(env.db)?.username).toBe("ada_l");
      expect(env.db.read(profileState.get(PROFILE_ID))?.name).toBe("ada_l");
    });

    it("a name that can't be a username, which the server says so about, and the form stays open to change it", async () => {
      const env = await named("Ada Lovelace");
      env.db.ops.account.openAccountForm({ form: "create" });

      await submit(env.db, request(env.db)?.username ?? "", PASSWORD);

      expect(request(env.db)).toMatchObject({
        state: "editing",
        username: "Ada Lovelace",
        error: "Username must be 3 to 32 letters, digits, dots, hyphens or underscores.",
      });
      expect(row(env.db)).toMatchObject({ username: null, accessToken: issued(1).accessToken });
    });
  });

  it("makes the username the name, in place of the name the guest had", async () => {
    const env = await creating();
    env.db.ops.profile.setName({ name: "Countess" });
    await settle();
    expect(env.db.read(profileState.get(PROFILE_ID))?.name).toBe("Countess");

    await submit(env.db, "Ada", PASSWORD);

    expect(env.db.read(profileState.get(PROFILE_ID))).toMatchObject({ state: "idle", name: "Ada" });
    expect(env.server.users.get("session-1")?.name).toBe("Ada");
  });

  it("restarts what sends the token, so the profile is read again with the new session", async () => {
    const env = await creating();
    expect(env.db.read(profileState.get(PROFILE_ID))).toMatchObject({ state: "idle", name: null });

    await submit(env.db, "Ada", PASSWORD);

    // The server starts the display name as the username.
    expect(env.db.read(profileState.get(PROFILE_ID))).toMatchObject({ state: "idle", name: "Ada" });
    const profileCalls = env.fetchMock.mock.calls.filter(([input]) => String(input) === "/api/me");
    expect(new Headers(profileCalls.at(-1)?.[1]?.headers).get("Authorization")).toBe("Bearer session-1");
  });

  it("does not keep the password in the db once it has been sent", async () => {
    const env = await creating();
    env.db.ops.account.submitAccountForm({ username: "Ada", password: PASSWORD });
    expect(request(env.db)).toMatchObject({ state: "submitting", password: PASSWORD });

    await settle();

    expect(request(env.db)).toBeUndefined();
  });

  it("is shown as submitting, with the guest marked as upgrading, until the answer", async () => {
    let answer: (res: Response) => void = () => {};
    const env = await creating({
      fetchImpl: (server) => (input, init) =>
        String(input) === "/api/account" ? new Promise<Response>((resolve) => (answer = resolve)) : server.fetchImpl(input, init),
    });

    env.db.ops.account.submitAccountForm({ username: "Ada", password: PASSWORD });
    await Promise.resolve();

    expect(request(env.db)).toMatchObject({ state: "submitting", form: "create" });
    expect(flags(env.db)?.upgrading).toBe(true);
    answer(new Response(null, { status: 500 }));
    await settle();
    expect(flags(env.db)?.upgrading).toBe(false);
  });

  it("restarts nothing while the account is being made: only the new session does", async () => {
    let answer: (res: Response) => void = () => {};
    const env = await creating({
      fetchImpl: (server) => (input, init) =>
        String(input) === "/api/account" ? new Promise<Response>((resolve) => (answer = resolve)) : server.fetchImpl(input, init),
    });

    env.db.ops.account.submitAccountForm({ username: "Ada", password: PASSWORD });
    await settle();

    // The profile is not read again, nor is anything else that sends the guest token.
    expect(calls(env)).toEqual(["POST /api/account"]);
    answer(
      new Response(JSON.stringify({ userId: issued(1).userId, accessToken: "session-1", username: "Ada" }), {
        status: 201,
      }),
    );
    env.server.users.set("session-1", { userId: issued(1).userId, name: null, username: "Ada" });
    await settle();
    expect(calls(env)).toEqual(["POST /api/account", "GET /api/me"]);
  });

  it("ignores the 401 that other requests get once the server has retired the guest token", async () => {
    let answer: (res: Response) => void = () => {};
    const env = await creating({
      fetchImpl: (server) => (input, init) =>
        String(input) === "/api/account" ? new Promise<Response>((resolve) => (answer = resolve)) : server.fetchImpl(input, init),
    });
    env.db.ops.account.submitAccountForm({ username: "Ada", password: PASSWORD });
    await Promise.resolve();

    // The server has made the account, so the guest token is dead, but the answer is not here yet.
    env.server.users.delete(issued(1).accessToken);
    const stale = await apiFetch({ db: env.db, run: env.db.run.bind(env.db) }, "/api/games");
    expect(stale.status).toBe(401);
    expect(row(env.db)).toMatchObject({ state: "ready", accessToken: issued(1).accessToken });

    env.server.users.set("session-1", { userId: issued(1).userId, name: null, username: "Ada" });
    answer(
      new Response(JSON.stringify({ userId: issued(1).userId, accessToken: "session-1", username: "Ada" }), {
        status: 201,
      }),
    );
    await settle();

    expect(row(env.db)).toMatchObject({ state: "ready", accessToken: "session-1", username: "Ada" });
    expect(env.fetchMock.mock.calls.filter(([input]) => String(input) === "/api/register")).toHaveLength(0);
  });

  it.each([
    ["a username that is taken, whatever its case", "ADA", "That username is taken."],
    ["a username that is too short", "ab", "Username must be 3 to 32 letters, digits, dots, hyphens or underscores."],
    ["a password that is too short", "grace", "Password must be 8 to 128 characters."],
  ])("keeps the form open with the server's reason for %s", async (_, username, error) => {
    const env = await creating();
    env.server.addAccount("ada", PASSWORD, OLD_SESSION);

    await submit(env.db, username, username === "grace" ? "short" : PASSWORD);

    expect(request(env.db)).toMatchObject({ form: "create", state: "editing", error, password: null });
    // Still a guest, with the token it had.
    expect(row(env.db)).toMatchObject({ accessToken: issued(1).accessToken, username: null });
    expect(flags(env.db)?.upgrading).toBe(false);
    // What is saved is still the guest's.
    expect(saved(env)).toEqual(issued(1));
  });

  it("asks nothing of the server for a form with nothing in it", async () => {
    const env = await creating();

    await submit(env.db, "  ", PASSWORD);
    expect(request(env.db)).toMatchObject({ state: "editing", error: "Enter a username and a password." });
    await submit(env.db, "Ada", "");

    expect(request(env.db)?.error).toBe("Enter a username and a password.");
    expect(env.fetchMock).not.toHaveBeenCalled();
  });

  it("drops the spaces around the username", async () => {
    const env = await creating();

    await submit(env.db, "  Ada ", PASSWORD);

    expect(row(env.db)?.username).toBe("Ada");
  });

  it("can be tried again after a refusal", async () => {
    const env = await creating();
    await submit(env.db, "ab", PASSWORD);

    await submit(env.db, "Ada", PASSWORD);

    expect(row(env.db)).toMatchObject({ username: "Ada", accessToken: "session-1" });
    expect(request(env.db)).toBeUndefined();
  });

  it("says so when the server can't be reached, and the guest keeps their token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = await creating({
      fetchImpl: (server) => (input, init) =>
        String(input) === "/api/account" ? Promise.reject(new TypeError("network down")) : server.fetchImpl(input, init),
    });

    await submit(env.db, "Ada", PASSWORD);

    expect(request(env.db)).toMatchObject({ state: "editing", error: "Could not reach the server. Try again." });
    expect(row(env.db)).toMatchObject({ state: "ready", accessToken: issued(1).accessToken, username: null });
    expect(flags(env.db)?.upgrading).toBe(false);
    warn.mockRestore();
  });

  it("says the session had ended when the guest's token is no good, and registers a new guest", async () => {
    const env = await creating();
    env.server.users.clear(); // the server lost the guest

    await submit(env.db, "Ada", PASSWORD);

    expect(request(env.db)).toMatchObject({ state: "editing", error: "Your session had ended. Try again." });
    expect(row(env.db)).toMatchObject({ state: "ready", ...issued(2) });
    expect(flags(env.db)?.upgrading).toBe(false);
  });

  it("can't be started by an account, or while a request is on its way", async () => {
    const account = await asAccount();
    account.db.ops.account.openAccountForm({ form: "create" });
    expect(request(account.db)).toBeUndefined();

    const env = await creating();
    env.db.ops.account.submitAccountForm({ username: "Ada", password: PASSWORD });
    env.db.ops.account.openAccountForm({ form: "signIn" });
    env.db.ops.account.closeAccountForm();
    expect(request(env.db)).toMatchObject({ form: "create", state: "submitting" });
    await settle();
  });

  it("closes the form when the user does, and nothing is sent", async () => {
    const env = await creating();

    env.db.ops.account.closeAccountForm();

    expect(request(env.db)).toBeUndefined();
    expect(env.fetchMock).not.toHaveBeenCalled();
  });
});

describe("signing in", () => {
  async function signingIn(options: Options = {}) {
    const env = await asGuest(options);
    env.server.addAccount("ada", PASSWORD, OLD_SESSION);
    env.db.ops.account.openAccountForm({ form: "signIn" });
    return env;
  }

  it("makes the account's new session the browser's, and saves it", async () => {
    const env = await signingIn();

    await submit(env.db, "ADA", PASSWORD);

    expect(row(env.db)).toMatchObject({
      state: "ready",
      userId: OLD_SESSION.userId,
      accessToken: "session-1",
      username: "ada",
    });
    expect(flags(env.db)?.signedOutAs).toBeNull();
    expect(saved(env)).toEqual({ userId: OLD_SESSION.userId, accessToken: "session-1", username: "ada" });
    expect(request(env.db)).toBeUndefined();
  });

  it("goes to the front page and shows the games of the user the browser is now", async () => {
    const env = await signingIn({ path: `/games/${gameIdOf(1)}` });
    env.server.addGame({ id: gameIdOf(1), kind: "long-backgammon", players: [issued(1).userId] });
    env.server.addGame({ id: gameIdOf(2), kind: "long-backgammon", players: [OLD_SESSION.userId, "bot"] });
    env.db.ops.lobby.loadGames();
    await settle();
    expect(gamesShown(env.db)).toEqual([gameIdOf(1)]);

    await submit(env.db, "ada", PASSWORD);

    expect(env.pushState).toHaveBeenCalledWith(null, "", "/");
    expect(env.db.read(locationState.get(LOCATION_ID))?.path).toBe("/");
    expect(gamesShown(env.db)).toEqual([gameIdOf(2)]);
    expect(env.db.read(gamesList.get(GAMES_LIST_ID))?.state).toBe("loaded");
  });

  it("does not push the front page again when the browser is on it", async () => {
    const env = await signingIn({ path: "/" });

    await submit(env.db, "ada", PASSWORD);

    expect(env.pushState).not.toHaveBeenCalled();
  });

  it("keeps the form open, without the password, when the password is wrong", async () => {
    const env = await signingIn();

    await submit(env.db, "ada", "not the password");

    expect(request(env.db)).toMatchObject({
      form: "signIn",
      state: "editing",
      error: "Wrong username or password.",
      password: null,
      username: "ada",
    });
    expect(row(env.db)).toMatchObject({ accessToken: issued(1).accessToken, username: null });
    expect(saved(env)).toEqual(issued(1));
  });

  it("gives the same answer for a username that doesn't exist", async () => {
    const env = await signingIn();

    await submit(env.db, "nobody", PASSWORD);

    expect(request(env.db)?.error).toBe("Wrong username or password.");
  });

  it("says how long to wait when it is turned away for trying too often", async () => {
    const env = await signingIn();
    env.server.lockLogins();

    await submit(env.db, "ada", PASSWORD);

    expect(request(env.db)?.error).toBe("Too many attempts. Try again in 10 minutes.");
  });

  it("starts the form with the username it is given, as after being signed out", async () => {
    const env = await asGuest();

    env.db.ops.account.openAccountForm({ form: "signIn", username: "ada" });

    expect(request(env.db)).toMatchObject({ form: "signIn", username: "ada", state: "editing", error: null });
  });

  it("does not send a password that is empty", async () => {
    const env = await signingIn();

    await submit(env.db, "ada", "");

    expect(request(env.db)?.error).toBe("Enter a username and a password.");
    expect(env.fetchMock).not.toHaveBeenCalled();
  });
});

describe("signing out", () => {
  it("ends the session on the server, forgets it here, and makes a new guest", async () => {
    const env = await asAccount();

    env.db.ops.account.signOut();
    await settle();

    expect(calls(env)).toContain("POST /api/logout");
    expect(env.server.users.has(OLD_SESSION.accessToken)).toBe(false);
    expect(row(env.db)).toMatchObject({ state: "ready", ...issued(1), username: null });
    expect(flags(env.db)?.signedOutAs).toBeNull();
    expect(saved(env)).toEqual(issued(1));
    expect(request(env.db)).toBeUndefined();
  });

  it("sends the session's token, and not a guest's", async () => {
    const env = await asAccount();

    env.db.ops.account.signOut();
    await settle();

    const logout = env.fetchMock.mock.calls.find(([input]) => String(input) === "/api/logout");
    expect(new Headers(logout?.[1]?.headers).get("Authorization")).toBe(`Bearer ${OLD_SESSION.accessToken}`);
  });

  it("goes to the front page and drops the games of the account", async () => {
    const env = await asAccount({ path: `/games/${gameIdOf(1)}` });
    env.server.addGame({ id: gameIdOf(1), kind: "long-backgammon", players: [OLD_SESSION.userId] });
    env.db.ops.lobby.loadGames();
    await settle();
    expect(gamesShown(env.db)).toEqual([gameIdOf(1)]);

    env.db.ops.account.signOut();
    await settle();

    expect(env.pushState).toHaveBeenCalledWith(null, "", "/");
    expect(env.db.read(locationState.get(LOCATION_ID))?.path).toBe("/");
    expect(gamesShown(env.db)).toEqual([]);
  });

  it("signs out here all the same when the server can't be reached", async () => {
    const env = await asAccount({
      fetchImpl: (server) => (input, init) =>
        String(input) === "/api/logout" ? Promise.reject(new TypeError("network down")) : server.fetchImpl(input, init),
    });

    env.db.ops.account.signOut();
    await settle();

    expect(row(env.db)).toMatchObject({ state: "ready", username: null });
    expect(saved(env)).toEqual(issued(1));
  });

  it("has nothing to do for a guest", async () => {
    const env = await asGuest();

    env.db.ops.account.signOut();
    await settle();

    expect(env.fetchMock).not.toHaveBeenCalled();
    expect(row(env.db)).toMatchObject({ accessToken: issued(1).accessToken });
  });
});

describe("deleting the user", () => {
  it("lets a guest do it without a password, and starts a new guest", async () => {
    const env = await asGuest({ path: `/games/${gameIdOf(1)}` });
    env.db.ops.account.openAccountForm({ form: "delete" });

    await submit(env.db, "", "");

    const call = env.fetchMock.mock.calls.find(([input]) => String(input) === "/api/me");
    expect(call?.[1]?.method).toBe("DELETE");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({});
    expect(env.server.users.has(issued(1).accessToken)).toBe(false);
    expect(row(env.db)).toMatchObject({ state: "ready", ...issued(2), username: null });
    expect(saved(env)).toEqual(issued(2));
    expect(env.pushState).toHaveBeenCalledWith(null, "", "/");
    expect(request(env.db)).toBeUndefined();
  });

  it("asks an account for its password before anything is sent", async () => {
    const env = await asAccount();
    env.db.ops.account.openAccountForm({ form: "delete" });

    await submit(env.db, "", "");

    expect(request(env.db)).toMatchObject({ state: "editing", error: "Enter your password." });
    expect(env.fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the account, with the reason, when the password is wrong", async () => {
    const env = await asAccount();
    env.db.ops.account.openAccountForm({ form: "delete" });

    await submit(env.db, "", "not the password");

    expect(request(env.db)).toMatchObject({ state: "editing", error: "Wrong password.", password: null });
    // A 403, not a 401: the session is as good as it was.
    expect(row(env.db)).toMatchObject({ accessToken: OLD_SESSION.accessToken, username: "ada" });
    expect(env.server.accounts.has("ada")).toBe(true);
  });

  it("deletes an account that gives its password, and the user is a guest again", async () => {
    const env = await asAccount({ path: "/privacy" });
    env.db.ops.account.openAccountForm({ form: "delete" });

    await submit(env.db, "", PASSWORD);

    const call = env.fetchMock.mock.calls.find(([input]) => String(input) === "/api/me");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ password: PASSWORD });
    expect(env.server.accounts.has("ada")).toBe(false);
    expect(env.server.users.has(OLD_SESSION.accessToken)).toBe(false);
    expect(row(env.db)).toMatchObject({ state: "ready", ...issued(1), username: null });
    expect(flags(env.db)?.signedOutAs).toBeNull();
    expect(saved(env)).toEqual(issued(1));
    expect(env.pushState).toHaveBeenCalledWith(null, "", "/");
    expect(gamesShown(env.db)).toEqual([]);
  });

  it("shows nothing of the account's games to the guest that follows", async () => {
    const env = await asAccount();
    env.server.addGame({ id: gameIdOf(1), kind: "long-backgammon", players: [OLD_SESSION.userId, "bot"] });
    env.db.ops.lobby.loadGames();
    await settle();
    expect(gamesShown(env.db)).toEqual([gameIdOf(1)]);
    env.db.ops.account.openAccountForm({ form: "delete" });

    await submit(env.db, "", PASSWORD);

    expect(gamesShown(env.db)).toEqual([]);
  });
});

describe("a session that ended without being asked to", () => {
  it("makes a guest of the browser and keeps the username, for the page to say so", async () => {
    const env = await asAccount();
    env.server.users.clear(); // the session expired, or was ended elsewhere

    await apiFetch({ db: env.db, run: env.db.run.bind(env.db) }, "/api/me");
    await settle();

    expect(row(env.db)).toMatchObject({ state: "ready", username: null, ...issued(1) });
    expect(flags(env.db)?.signedOutAs).toBe("ada");
  });

  it("is let go without restarting anything that sends the token", async () => {
    const env = await asAccount();
    env.server.users.clear();
    await apiFetch({ db: env.db, run: env.db.run.bind(env.db) }, "/api/me");
    await settle();
    env.fetchMock.mockClear();

    env.db.ops.session.signedOutNoticeDismissed();
    await settle();

    expect(flags(env.db)?.signedOutAs).toBeNull();
    expect(env.fetchMock).not.toHaveBeenCalled();
  });

  it("is told to the user until they sign in or let it go", async () => {
    const env = await asAccount();
    env.server.users.clear();
    env.server.addAccount("ada", PASSWORD, OLD_SESSION);
    await apiFetch({ db: env.db, run: env.db.run.bind(env.db) }, "/api/me");
    await settle();

    env.db.ops.account.openAccountForm({ form: "signIn", username: flags(env.db)?.signedOutAs ?? "" });
    await submit(env.db, "ada", PASSWORD);

    expect(row(env.db)?.username).toBe("ada");
    expect(flags(env.db)?.signedOutAs).toBeNull();
  });
});
