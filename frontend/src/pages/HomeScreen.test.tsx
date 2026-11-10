import { createDb } from "millpond";
import { DbProvider } from "millpond/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { router } from "../features/router";
import { GAMES } from "../games";
import { gameIdOf } from "../testing";
import {
  type GamesListRow,
  HomeScreen,
  type HomeScreenProps,
  type MyGameRow,
  type NewGameRow,
  gameStateText,
  playersText,
} from "./HomeScreen";

// Rendering to a string shows the first moment, before the loading text has waited its second.
// This one says it at once, which shows whether the page is waiting (see immediateLoading.tsx).
vi.mock("../Loading", () => import("../immediateLoading"));

// What the page shows is a function of its props, so these render it to a string.
// (There is no DOM here: clicks are covered by the ops they call, in the lobby tests.)

const dbs: { dispose(): void }[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
});

function render(overrides: Partial<HomeScreenProps> = {}) {
  const db = createDb({ features: { router } });
  dbs.push(db);
  const noop = () => { };
  return renderToString(
    <DbProvider db={db}>
      <HomeScreen
        games={GAMES}
        mine={[]}
        list={{ id: "mine", state: "loaded", error: null }}
        request={undefined}
        onNewGame={noop}
        onOpponent={noop}
        onLevel={noop}
        onPublic={noop}
        onCreate={noop}
        onClose={noop}
        onReload={noop}
        {...overrides}
      />
    </DbProvider>,
  );
}

const game = (n: number, overrides: Partial<MyGameRow> = {}): MyGameRow => ({
  gameId: gameIdOf(n),
  kind: "long-backgammon",
  seat: 0,
  joined: 2,
  started: true,
  finished: false,
  updatedAt: 1_700_000_000_000 + n * 60_000,
  playerNames: ["Ada", "Grace"],
  playerGuests: [false, false],
  ...overrides,
});

const request = (overrides: Partial<NewGameRow> = {}): NewGameRow => ({
  id: "current",
  state: "choosing",
  kind: "long-backgammon",
  bot: false,
  level: "medium",
  public: true,
  error: null,
  ...overrides,
});

describe("the title of the page", () => {
  it("is not shown, but a screen reader has one", () => {
    const html = render();

    expect(html).toContain('<h1 class="visually-hidden">Games</h1>');
    expect(html).not.toContain("page-header");
    expect(html).not.toContain("Simple board games");
  });
});

describe("the games to start", () => {
  it("are buttons that open the dialog, not links to a page of their own", () => {
    const html = render();

    expect(html).toMatch(/<button[^>]*class="game-card"/);
    expect(html).toContain("Long backgammon");
    expect(html).toContain("2 players");
    expect(html).not.toContain('href="/games/long-backgammon"');
  });
});

describe("where a game stands", () => {
  it("is waiting, in progress or finished", () => {
    expect(gameStateText({ started: false, finished: false })).toBe("Waiting for an opponent");
    expect(gameStateText({ started: true, finished: false })).toBe("In progress");
    expect(gameStateText({ started: true, finished: true })).toBe("Finished");
  });

  it("is never in progress once the game is finished", () => {
    const html = render({ mine: [game(1, { finished: true })] });

    expect(html).toContain("Finished");
    expect(html).not.toContain("In progress");
    expect(html).toContain("my-game-state my-game-state-done");
  });

  it("is drawn with its own dot: one for a game in play, one for a game that waits, one for a finished one", () => {
    const html = render({
      mine: [game(1, { started: true }), game(2, { started: false }), game(3, { finished: true })],
    });

    expect(html).toContain("my-game-state my-game-state-live");
    expect(html).toContain("my-game-state my-game-state-waiting");
    expect(html).toContain("my-game-state my-game-state-done");
  });

  it("is on the same row as the date of the last change", () => {
    const html = render({ mine: [game(1)] });

    const meta = html.slice(html.indexOf('class="my-game-meta"'));
    const row = meta.slice(0, meta.indexOf("</span></a>"));
    expect(row).toContain("In progress");
    expect(row).toContain("<time");
    // The players are on a row of their own above it.
    expect(html.indexOf("my-game-players")).toBeLessThan(html.indexOf("my-game-meta"));
  });

  it("shows each game's own state in the list", () => {
    const html = render({
      mine: [game(3, { finished: true }), game(2), game(1, { started: false, joined: 1 })],
    });

    expect(html).toContain("Finished");
    expect(html).toContain("In progress");
    expect(html).toContain("Waiting for an opponent");
  });
});

describe("the players of a game", () => {
  const accounts = [false, false];

  it("are named in seat order, with the user marked", () => {
    expect(playersText({ seat: 0, playerNames: ["Ada", "Grace"], playerGuests: accounts })).toBe(
      "Ada (you) vs Grace",
    );
    expect(playersText({ seat: 1, playerNames: ["Ada", "Grace"], playerGuests: accounts })).toBe(
      "Ada vs Grace (you)",
    );
  });

  it("are only the ones who have joined", () => {
    expect(playersText({ seat: 0, playerNames: ["Ada"], playerGuests: [false] })).toBe("Ada (you)");
  });

  it("get a stand-in name when they have none", () => {
    expect(playersText({ seat: 0, playerNames: [null, null], playerGuests: [true, true] })).toBe(
      "You vs Player 2",
    );
    expect(playersText({ seat: 1, playerNames: [null, null], playerGuests: [true, true] })).toBe(
      "Player 1 vs You",
    );
  });

  it("mark another player who is a guest, and not the user, who knows", () => {
    expect(playersText({ seat: 0, playerNames: ["Ada", "Grace"], playerGuests: [true, true] })).toBe(
      "Ada (you) vs Grace (guest)",
    );
    expect(playersText({ seat: 1, playerNames: ["Ada", "Grace"], playerGuests: [true, true] })).toBe(
      "Ada (guest) vs Grace (you)",
    );
  });

  it("do not mark the bot", () => {
    expect(playersText({ seat: 0, playerNames: ["Ada", "Bot"], playerGuests: [true, false] })).toBe(
      "Ada (you) vs Bot",
    );
  });

  it("show in the list of the user's games, each game with its own", () => {
    const html = render({
      mine: [
        game(2),
        game(1, { seat: 0, started: false, joined: 1, playerNames: ["Ada"] }),
        game(3, { seat: 1 }),
      ],
    });

    expect(html).toContain("Ada (you) vs Grace");
    expect(html).toContain(">Ada (you)<");
    expect(html).toContain("Ada vs Grace (you)");
  });
});

describe("the user's games", () => {
  it("come before the games to start, which puts them on the left", () => {
    const html = render({ mine: [game(1)] });

    expect(html.indexOf("Your games")).toBeGreaterThan(-1);
    expect(html.indexOf("Your games")).toBeLessThan(html.indexOf("Start a game"));
  });

  it("are links to their pages, in the order they are given", () => {
    const html = render({ mine: [game(2), game(1, { started: false })] });

    const first = html.indexOf(`href="/games/${gameIdOf(2)}"`);
    const second = html.indexOf(`href="/games/${gameIdOf(1)}"`);
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(html).toContain("In progress");
    expect(html).toContain("Waiting for an opponent");
  });

  it("leave out a game of a kind the site has no page for", () => {
    const html = render({ mine: [game(1), game(2, { kind: "chess" })] });

    expect(html).toContain(gameIdOf(1));
    expect(html).not.toContain(gameIdOf(2));
  });

  it("say so when there are none", () => {
    expect(render({ mine: [] })).toContain("You have no games yet.");
  });

  it("say they are loading until the first read is done", () => {
    const loading: GamesListRow = { id: "mine", state: "loading", error: null };

    const html = render({ list: loading });

    expect(html).toContain("Loading…");
    expect(html).not.toContain("You have no games yet.");
  });

  it("show the games already known while they are read again", () => {
    const loading: GamesListRow = { id: "mine", state: "loading", error: null };

    const html = render({ list: loading, mine: [game(1)] });

    expect(html).toContain(gameIdOf(1));
    expect(html).not.toContain("Loading…");
  });

  it("show why they could not be read, with a way to try again", () => {
    const failed: GamesListRow = { id: "mine", state: "failed", error: "TypeError: network down" };

    const html = render({ list: failed });

    expect(html).toContain("Could not load your games");
    expect(html).toContain("network down");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Loading…");
  });
});

describe("the dialog for creating a game", () => {
  it("is not there until a game is picked", () => {
    expect(render()).not.toContain("<dialog");
  });

  it("says what is being created and offers to create it or cancel", () => {
    const html = render({ request: request() });

    expect(html).toContain("<dialog");
    expect(html).toContain("Long backgammon");
    expect(html).toContain("Race all fifteen of your checkers");
    expect(html).toContain("Create game");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Creating…");
  });

  it("offers the bot as the opponent for a game that has one, with a friend picked to begin with", () => {
    const html = render({ request: request() });

    expect(html).toContain("Play vs a friend");
    expect(html).toContain("Play vs a bot");
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*checked=""[^>]*\/><span class="choice-name">Play vs a friend/);
    expect(html).toContain("Create game");
    expect(html).not.toContain("Start game");
  });

  it("offers the two opponents as plain labels, with no line of explanation under either", () => {
    const html = render({ request: request() });

    expect(html).not.toContain("choice-text");
    expect(html).not.toContain("starts right away");
    expect(html).not.toContain("Anyone who has");
  });

  it("shows the bot picked, and still calls the button Create game", () => {
    const html = render({ request: request({ bot: true }) });

    expect(html).toMatch(/<input[^>]*type="radio"[^>]*checked=""[^>]*\/><span class="choice-name">Play vs a bot/);
    expect(html).toContain("Create game");
    expect(html).not.toContain("Start game");
  });

  it("offers no level for a friend, who is not a bot", () => {
    const html = render({ request: request({ bot: false }) });

    expect(html).not.toContain("Easy");
    expect(html).not.toContain('name="level"');
  });

  it("offers the three levels once the bot is picked, with medium picked to begin with", () => {
    const html = render({ request: request({ bot: true }) });

    const levels = [...html.matchAll(/<input[^>]*name="level"[^>]*\/><span class="segmented-name">(\w+)</g)].map(
      (match) => match[1],
    );
    expect(levels).toEqual(["Easy", "Medium", "Hard"]);
    expect(html).toMatch(/<input[^>]*name="level"[^>]*checked=""[^>]*\/><span class="segmented-name">Medium/);
    expect(html.match(/name="level"[^>]*checked=""/g)).toHaveLength(1);
  });

  it("lays the three levels out in one row, as a segmented choice and not a list", () => {
    const html = render({ request: request({ bot: true }) });

    // The levels are cells of one control, and the opponent above them is still a list.
    expect(html.match(/class="segmented-option"/g)).toHaveLength(3);
    expect(html.match(/<fieldset[^>]*class="segmented"/g)).toHaveLength(1);
    expect(html.match(/<fieldset[^>]*class="choice"/g)).toHaveLength(1);
    // The radios are hidden but still radios, so the arrow keys move between the levels.
    expect(html.match(/<input[^>]*class="visually-hidden"[^>]*type="radio"[^>]*name="level"/g)).toHaveLength(3);
  });

  it("shows the level that was picked", () => {
    const html = render({ request: request({ bot: true, level: "hard" }) });

    expect(html).toMatch(/<input[^>]*name="level"[^>]*checked=""[^>]*\/><span class="segmented-name">Hard/);
    expect(html.match(/name="level"[^>]*checked=""/g)).toHaveLength(1);
  });

  it("can't change the level while the game is being made, like the opponent", () => {
    const html = render({ request: request({ bot: true, state: "creating" }) });

    // The opponent and the level, and the box for a public game, are all fixed now.
    expect(html.match(/<fieldset[^>]*disabled=""/g)).toHaveLength(2);
  });

  it("has no choice of opponent for a game with no bot, only the link to send", () => {
    const withoutBot = GAMES.map((game) => ({ ...game, bot: false }));

    const html = render({ games: withoutBot, request: request() });

    expect(html).not.toContain("Play vs a bot");
    expect(html).toContain("You get a link to send to your opponent.");
    expect(html).toContain("Create game");
  });

  it("has a box for a public game, ticked when the game is to be public", () => {
    const html = render({ request: request({ public: true }) });

    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
    expect(html).toContain("Public game");
    expect(html).toContain("Listed for anyone to watch once it has started.");
  });

  it("has the box unticked when the game is to be private", () => {
    const html = render({ request: request({ public: false }) });

    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
  });

  it("has the box for a game with no bot too", () => {
    const withoutBot = GAMES.map((game) => ({ ...game, bot: false }));

    const html = render({ games: withoutBot, request: request() });

    expect(html).toMatch(/<input[^>]*type="checkbox"/);
  });

  it("can't be cancelled while the game is being made", () => {
    const html = render({ request: request({ state: "creating" }) });

    expect(html).toContain("Creating…");
    expect(html).not.toContain("Create game");
    // Both buttons are disabled: Cancel, and the one that now says "Creating…". So is the
    // choice of opponent, which the request that has gone out can no longer take.
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    // The request has gone out as it was, so the box can't change it either.
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""/);
  });

  it("shows why the game could not be made, and offers to try again", () => {
    const html = render({ request: request({ state: "failed", error: "Error: HTTP 500" }) });

    expect(html).toContain("Could not create the game");
    expect(html).toContain("HTTP 500");
    expect(html).toContain("Create game");
    expect(html).not.toContain("disabled");
  });

  it("names a kind that the catalog doesn't know by its id, without a description", () => {
    // Only the dialog: the card for the game it is not about is still on the page behind it.
    const html = render({ request: request({ kind: "chess" }) });
    const dialog = html.slice(html.indexOf("<dialog"));

    expect(dialog).toContain("chess");
    expect(dialog).not.toContain("Race all fifteen");
  });
});
