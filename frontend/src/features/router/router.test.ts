import { createDb } from "millpond";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gameIdOf } from "../../testing";
import { LOCATION_ID, bindBrowserLocation, gamePath, locationState, parseRoute, router } from "./index";

const ID = gameIdOf(7);

describe("parseRoute", () => {
  it("knows the home page", () => {
    expect(parseRoute("/")).toEqual({ page: "home" });
  });

  it("has no page for a kind of game of its own: starting one is a dialog on the home page", () => {
    expect(parseRoute("/games/long-backgammon")).toEqual({ page: "notFound" });
    expect(parseRoute("/games/long-backgammon/")).toEqual({ page: "notFound" });
  });

  it("knows a game page, and what it takes to make the link", () => {
    const route = { page: "game", kind: "long-backgammon", gameId: ID };
    expect(parseRoute(`/games/long-backgammon/${ID}`)).toEqual(route);
    expect(parseRoute(gamePath("long-backgammon", ID))).toEqual(route);
  });

  it("reads a pasted upper-case id as the same game", () => {
    expect(parseRoute(`/games/long-backgammon/${ID.toUpperCase()}`)).toMatchObject({ gameId: ID });
  });

  it.each([
    "/nope",
    "/games",
    "/games/chess",
    `/games/chess/${ID}`,
    "/games/long-backgammon/not-an-id",
    `/games/long-backgammon/${ID}/extra`,
    `/games/long-backgammon//${ID}`,
    "//games/long-backgammon",
  ])("has no page at %s", (path) => {
    expect(parseRoute(path)).toEqual({ page: "notFound" });
  });
});

describe("the router's row", () => {
  const dbs: { dispose(): void }[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.dispose();
  });

  function setup() {
    const db = createDb({ features: { router } });
    dbs.push(db);
    return db;
  }

  it("holds the latest path", () => {
    const db = setup();

    db.ops.router.pathChanged({ path: "/games/long-backgammon" });
    db.ops.router.pathChanged({ path: "/" });

    expect(db.read(locationState.get(LOCATION_ID))?.path).toBe("/");
  });

  it("follows the address bar: now, and on every back or forward", () => {
    const db = setup();
    const win = new EventTarget() as unknown as Window;
    Object.defineProperty(win, "location", { value: { pathname: "/games/long-backgammon" } });
    const path = () => db.read(locationState.get(LOCATION_ID))?.path;

    const stop = bindBrowserLocation(db.ops.router.pathChanged, win);
    expect(path()).toBe("/games/long-backgammon");

    (win.location as { pathname: string }).pathname = "/";
    win.dispatchEvent(new Event("popstate"));
    expect(path()).toBe("/");

    stop();
    (win.location as { pathname: string }).pathname = "/elsewhere";
    win.dispatchEvent(new Event("popstate"));
    expect(path()).toBe("/");
  });
});

describe("pushPath", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds a history entry without reloading", async () => {
    const pushState = vi.fn();
    vi.stubGlobal("history", { pushState });
    const { pushPath } = await import("./browser");

    pushPath("/games/long-backgammon");

    expect(pushState).toHaveBeenCalledWith(null, "", "/games/long-backgammon");
  });
});
