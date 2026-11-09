import { createDb } from "millpond";
import { DbProvider } from "millpond/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { router } from "../features/router";
import { GAMES } from "../games";
import { gameIdOf } from "../testing";
import {
  PublicGamesScreen,
  type PublicGamesScreenProps,
  type PublicGameRow,
  type PublicListRow,
  publicPlayersText,
} from "./PublicGamesScreen";

// What the page shows is a function of its props, so these render it to a string.

const dbs: { dispose(): void }[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
});

function render(overrides: Partial<PublicGamesScreenProps> = {}) {
  const db = createDb({ features: { router } });
  dbs.push(db);
  return renderToString(
    <DbProvider db={db}>
      <PublicGamesScreen
        games={GAMES}
        listed={[]}
        list={{ id: "public", state: "loaded", error: null }}
        onReload={() => {}}
        {...overrides}
      />
    </DbProvider>,
  );
}

const game = (n: number, overrides: Partial<PublicGameRow> = {}): PublicGameRow => ({
  gameId: gameIdOf(n),
  kind: "long-backgammon",
  finished: false,
  updatedAt: 1_700_000_000_000 + n * 60_000,
  playerNames: ["Ada", "Grace"],
  playerGuests: [false, false],
  ...overrides,
});

describe("the players of a public game", () => {
  it("are named in seat order, and nobody is you", () => {
    expect(publicPlayersText({ playerNames: ["Ada", "Grace"], playerGuests: [false, false] })).toBe(
      "Ada vs Grace",
    );
  });

  it("get a stand-in name when they have none", () => {
    expect(publicPlayersText({ playerNames: [null, null], playerGuests: [true, true] })).toBe(
      "Player 1 vs Player 2",
    );
  });

  it("are marked when they are guests, but the bot is not", () => {
    expect(publicPlayersText({ playerNames: ["Ada", "Bot"], playerGuests: [true, false] })).toBe(
      "Ada (guest) vs Bot",
    );
  });
});

describe("the public list", () => {
  it("shows no title, but has one for a screen reader", () => {
    const html = render();

    expect(html).toContain('<h1 class="visually-hidden">Public games</h1>');
    expect(html).not.toContain("page-header");
    expect(html).not.toContain("Anyone can watch.");
  });

  it("is as wide as the front page", () => {
    expect(render()).toContain('<main class="page page-wide">');
  });

  it("lists the games as links to their pages, in the order given", () => {
    const html = render({ listed: [game(2), game(1)] });

    const first = html.indexOf(`href="/games/${gameIdOf(2)}"`);
    const second = html.indexOf(`href="/games/${gameIdOf(1)}"`);
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(html).toContain("Long backgammon");
    expect(html).toContain("Ada vs Grace");
  });

  it("says whether each game is in progress or finished, and never that it waits", () => {
    const html = render({ listed: [game(2, { finished: true }), game(1)] });

    expect(html).toContain("my-game-state my-game-state-done");
    expect(html).toContain("my-game-state my-game-state-live");
    expect(html).toContain("Finished");
    expect(html).toContain("In progress");
    expect(html).not.toContain("Waiting for an opponent");
  });

  it("leaves out a game of a kind the site has no page for", () => {
    const html = render({ listed: [game(1), game(2, { kind: "chess" })] });

    expect(html).toContain(gameIdOf(1));
    expect(html).not.toContain(gameIdOf(2));
  });

  it("says so when there are none", () => {
    expect(render({ listed: [] })).toContain("No public games yet.");
  });

  it("says it is loading until the first read is done", () => {
    const loading: PublicListRow = { id: "public", state: "loading", error: null };

    const html = render({ list: loading });

    expect(html).toContain("Loading…");
    expect(html).not.toContain("No public games yet.");
  });

  it("says it is loading before the first read has started", () => {
    expect(render({ list: undefined })).toContain("Loading…");
  });

  it("shows the games already known while it is read again", () => {
    const loading: PublicListRow = { id: "public", state: "loading", error: null };

    const html = render({ list: loading, listed: [game(1)] });

    expect(html).toContain(gameIdOf(1));
    expect(html).not.toContain("Loading…");
  });

  it("shows why it could not be read, with a way to try again", () => {
    const failed: PublicListRow = { id: "public", state: "failed", error: "TypeError: network down" };

    const html = render({ list: failed });

    expect(html).toContain("Could not load the public games");
    expect(html).toContain("network down");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Loading…");
    expect(html).not.toContain("No public games yet.");
  });
});
