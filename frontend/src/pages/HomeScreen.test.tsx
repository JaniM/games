import { createDb } from "millpond";
import { DbProvider } from "millpond/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
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

// What the page shows is a function of its props, so these render it to a string.
// (There is no DOM here: clicks are covered by the ops they call, in the lobby tests.)

const dbs: { dispose(): void }[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
});

function render(overrides: Partial<HomeScreenProps> = {}) {
  const db = createDb({ features: { router } });
  dbs.push(db);
  const noop = () => {};
  return renderToString(
    <DbProvider db={db}>
      <HomeScreen
        games={GAMES}
        mine={[]}
        list={{ id: "mine", state: "loaded", error: null }}
        request={undefined}
        onNewGame={noop}
        onOpponent={noop}
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
  ...overrides,
});

const request = (overrides: Partial<NewGameRow> = {}): NewGameRow => ({
  id: "current",
  state: "choosing",
  kind: "long-backgammon",
  bot: false,
  error: null,
  ...overrides,
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
  it("are named in seat order, with the user marked", () => {
    expect(playersText({ seat: 0, playerNames: ["Ada", "Grace"] })).toBe("Ada (you) vs Grace");
    expect(playersText({ seat: 1, playerNames: ["Ada", "Grace"] })).toBe("Ada vs Grace (you)");
  });

  it("are only the ones who have joined", () => {
    expect(playersText({ seat: 0, playerNames: ["Ada"] })).toBe("Ada (you)");
  });

  it("get a stand-in name when they have none", () => {
    expect(playersText({ seat: 0, playerNames: [null, null] })).toBe("You vs Player 2");
    expect(playersText({ seat: 1, playerNames: [null, null] })).toBe("Player 1 vs You");
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
    expect(html).toContain("New game: Long backgammon");
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

  it("has no choice of opponent for a game with no bot, only the link to send", () => {
    const withoutBot = GAMES.map((game) => ({ ...game, bot: false }));

    const html = render({ games: withoutBot, request: request() });

    expect(html).not.toContain("Play vs a bot");
    expect(html).toContain("You get a link to send to your opponent.");
    expect(html).toContain("Create game");
  });

  it("can't be cancelled while the game is being made", () => {
    const html = render({ request: request({ state: "creating" }) });

    expect(html).toContain("Creating…");
    expect(html).not.toContain("Create game");
    // Both buttons are disabled: Cancel, and the one that now says "Creating…". So is the
    // choice of opponent, which the request that has gone out can no longer take.
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
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

    expect(dialog).toContain("New game: chess");
    expect(dialog).not.toContain("Race all fifteen");
  });
});
