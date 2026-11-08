import { createDb } from "millpond";
import { DbProvider } from "millpond/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { GAME_ID, board, moving, snapshotOf, startingState } from "../fixtures";
import { router } from "../features/router";
import { GameScreen, type GameScreenProps, type GameViewRow } from "./GameScreen";

// What a page shows is a function of its props, so these render it to a string.
// (There is no DOM here: clicks are covered by the helpers and ops they call.)

const ADA = "user-a";
const GRACE = "user-b";
const STRANGER = "user-x";
const URL = `https://games.test/games/long-backgammon/${GAME_ID}`;

const dbs: { dispose(): void }[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
});

function viewOf(overrides: Partial<GameViewRow> = {}): GameViewRow {
  return {
    gameId: GAME_ID,
    connection: "open",
    snapshot: snapshotOf(),
    problem: null,
    error: null,
    busy: false,
    selected: null,
    ...overrides,
  };
}

function render(userId: string | null, view: GameViewRow | undefined, extra: Partial<GameScreenProps> = {}) {
  const db = createDb({ features: { router } });
  dbs.push(db);
  const noop = () => {};
  return renderToString(
    <DbProvider db={db}>
      <GameScreen
        view={view}
        userId={userId}
        join={undefined}
        inviteUrl={URL}
        onJoin={noop}
        onRoll={noop}
        onSelect={noop}
        onMove={noop}
        {...extra}
      />
    </DbProvider>,
  );
}

/** A game with Ada waiting alone for an opponent. */
const waiting = viewOf({
  snapshot: snapshotOf({ players: [ADA], playerNames: ["Ada"], state: null }),
});

describe("a game that is waiting for an opponent", () => {
  it("gives its creator the link to send, and a way to copy it", () => {
    const html = render(ADA, waiting);

    expect(html).toContain(`value="${URL}"`);
    expect(html).toContain("Copy link");
    expect(html).toContain("Waiting for an opponent…");
    expect(html).toContain("Ada (you)");
    expect(html).not.toContain("Join game");
  });

  it("shows the board in its starting position", () => {
    const html = render(ADA, waiting);

    expect(html).toContain('aria-label="Board"');
    expect(html).toContain(">15<"); // the fifteen on the head
  });

  it("offers a visitor a button to join, not the invite", () => {
    const html = render(STRANGER, waiting);

    expect(html).toContain("Join game");
    expect(html).not.toContain("Copy link");
    expect(html).not.toContain("You are watching");
  });

  it("holds the join button back until the connection is open", () => {
    const html = render(STRANGER, { ...waiting, connection: "reconnecting" });

    expect(html).toMatch(/<button[^>]*disabled[^>]*>Join game/);
  });

  it("shows why a join failed, and the progress of one", () => {
    expect(render(STRANGER, waiting, { join: { gameId: GAME_ID, state: "failed", error: "Both seats are taken." } }))
      .toContain("Could not join: Both seats are taken.");
    expect(render(STRANGER, waiting, { join: { gameId: GAME_ID, state: "joining", error: null } }))
      .toContain("Joining…");
  });

  it("does not offer a seat before the user is known", () => {
    expect(render(null, waiting)).not.toContain("Join game");
  });
});

describe("a game with both players", () => {
  it("tells a spectator they are watching, without a join button or roll button", () => {
    const html = render(STRANGER, viewOf());

    expect(html).toContain("You are watching this game.");
    expect(html).not.toContain("Join game");
    expect(html).not.toContain("Roll dice");
    expect(html).not.toContain("Copy link");
    expect(html).toContain("Waiting for Ada to roll.");
  });

  it("asks the player to move to roll, and nobody else", () => {
    const mover = render(ADA, viewOf());
    expect(mover).toContain("Roll dice");
    expect(mover).toContain("Your turn. Roll the dice.");
    expect(mover).not.toContain("You are watching");

    const other = render(GRACE, viewOf());
    expect(other).not.toContain("Roll dice");
    expect(other).toContain("Waiting for Ada to roll.");
  });

  it("does not offer a second roll while the first is on its way", () => {
    expect(render(ADA, viewOf({ busy: true }))).not.toContain("Roll dice");
  });

  it("names the players and says who is White and who moves", () => {
    const html = render(GRACE, viewOf());

    expect(html).toContain("Grace (you)");
    expect(html).toContain(">Ada<");
    expect(html).toContain(">White<");
    expect(html).toContain(">Black<");
    expect(html).toContain("to move");
  });

  it("shows the dice, and lets the mover pick a checker", () => {
    const state = startingState(moving([6, 3], [{ from: 1, die: 6 }, { from: 1, die: 3 }]));
    const html = render(ADA, viewOf({ snapshot: snapshotOf({ state }) }));

    expect(html).toContain('aria-label="Dice"');
    expect(html).toContain("Move a checker from point 1");
    expect(html).not.toContain("Roll dice");
  });

  it("shows where the selected checker can go, one place per die", () => {
    const state = startingState(moving([6, 3], [{ from: 1, die: 6 }, { from: 1, die: 3 }]));
    const html = render(ADA, viewOf({ snapshot: snapshotOf({ state }), selected: 1 }));

    expect(html).toContain("Move to point 7 with the 6");
    expect(html).toContain("Move to point 4 with the 3");
  });

  it("offers a bear off with each die that can do it", () => {
    const state = startingState({
      points: [board({ 20: 15 }), board({ 1: 15 })],
      ...moving([6, 5], [{ from: 20, die: 6 }, { from: 20, die: 5 }]),
    });
    const html = render(ADA, viewOf({ snapshot: snapshotOf({ state }), selected: 20 }));

    expect(html).toContain("Bear off with the 5");
    expect(html).toContain("Bear off with the 6");
  });

  it("shows nothing to click to someone who is not the mover", () => {
    const state = startingState(moving([6, 3], [{ from: 1, die: 6 }]));
    const html = render(GRACE, viewOf({ snapshot: snapshotOf({ state }), selected: 1 }));

    expect(html).not.toContain("Move a checker from");
    expect(html).not.toContain("Move to point");
    expect(html).toContain("Waiting for Ada to move.");
  });

  it("shows the server's reason for a refused move", () => {
    expect(render(ADA, viewOf({ error: "that move is blocked" }))).toContain("that move is blocked");
  });

  it("says what the last turn was, and warns about the last throw", () => {
    const state = startingState({
      turn: 1,
      lastThrow: true,
      lastTurn: { seat: 0, dice: [6, 5], played: [] },
    });
    const html = render(GRACE, viewOf({ snapshot: snapshotOf({ state }) }));

    expect(html).toContain("Ada rolled 6-5 and could not move.");
    expect(html).toContain("White has borne off everything. Black gets one last throw.");
  });

  it("shows the result when the game is over, and no one to move", () => {
    const state = startingState({
      off: [15, 3],
      phase: { type: "over", winner: 0, points: 1 },
    });
    const html = render(GRACE, viewOf({ snapshot: snapshotOf({ state }) }));

    expect(html).toContain("Ada won the game (1 point).");
    expect(html).not.toContain("to move");
    expect(html).not.toContain("Roll dice");
  });
});

describe("a game that cannot be shown", () => {
  it("says it is connecting before the first snapshot", () => {
    expect(render(ADA, viewOf({ connection: "connecting", snapshot: null }))).toContain(
      "Connecting to the game…",
    );
    expect(render(ADA, undefined)).toContain("Connecting to the game…");
  });

  it("says when there is no such game", () => {
    expect(render(ADA, viewOf({ connection: "missing", snapshot: null }))).toContain(
      "There is no game at this link.",
    );
  });

  it("says when the state is not one this site understands", () => {
    const html = render(ADA, viewOf({ problem: "This game needs a newer version of the site." }));

    expect(html).toContain("This game needs a newer version of the site.");
    expect(html).not.toContain('aria-label="Board"');
  });

  it("keeps the board while it reconnects, and says so", () => {
    const html = render(ADA, viewOf({ connection: "reconnecting" }));

    expect(html).toContain("Connection lost. Reconnecting…");
    expect(html).toContain('aria-label="Board"');
    expect(html).not.toContain("Roll dice");
  });
});

describe("the view from each side", () => {
  it("is White's for a spectator and the player's own for a player", () => {
    // Seat 1 is White and has moved a checker to its own point 4. Seat 0 calls that point 16.
    const state = startingState({
      white: 1,
      points: [board({ 1: 15 }), board({ 1: 14, 4: 1 })],
    });
    const view = viewOf({ snapshot: snapshotOf({ state }) });
    const pointOf = (html: string, n: number) =>
      new RegExp(`class="point-number"[^>]*>${n}<`).test(html);

    expect(pointOf(render(STRANGER, view), 4)).toBe(true);
    expect(render(STRANGER, view)).toContain(">White<");
    expect(pointOf(render(ADA, view), 16)).toBe(true);
  });
});
