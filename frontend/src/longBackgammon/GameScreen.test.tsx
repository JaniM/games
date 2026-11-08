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
    auto: false,
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
        onUndo={noop}
        onAutoplay={noop}
        onSelect={noop}
        onMove={noop}
        volume={0.7}
        onVolume={noop}
        onCue={noop}
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

  it("puts the roll button on the board, under the dice, not in the turn controls", () => {
    const html = render(ADA, viewOf());

    const wrap = html.slice(html.indexOf('class="board-wrap"'), html.indexOf('aria-label="Turn"'));
    expect(wrap).toContain("Roll dice");
    // After the board, positioned by percentages of it, centred under the dice.
    expect(wrap.indexOf("</svg>")).toBeLessThan(wrap.indexOf("Roll dice"));
    expect(wrap).toMatch(/class="button under-dice"[^>]*style="left:65\.56%;top:\d+\.\d+%"/);
    expect(html.slice(html.indexOf('aria-label="Turn"'))).not.toContain("Roll dice");
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
    // Ada is White, whose head is point 24.
    expect(html).toContain("Move a checker from point 24");
    expect(html).not.toContain("Roll dice");
  });

  it("puts the dice on the board, not beside it", () => {
    const state = startingState(moving([6, 3], [{ from: 1, die: 6 }]));
    const html = render(ADA, viewOf({ snapshot: snapshotOf({ state }) }));

    const board = html.slice(html.indexOf('<svg class="board"'), html.indexOf("</svg>"));
    expect(board).toContain('aria-label="Dice"');
    expect(html.replace(board, "")).not.toContain('aria-label="Dice"');
    expect(board).toContain('aria-label="6"');
    expect(board).toContain('aria-label="3"');
  });

  it("dims the dice that were played, and keeps the last turn's dice on the board", () => {
    const midway = startingState(moving([6, 3], [{ from: 7, die: 3 }], [{ from: 1, die: 6 }], [3]));
    const html = render(ADA, viewOf({ snapshot: snapshotOf({ state: midway }) }));
    expect(html).toContain('aria-label="6, played"');
    expect(html).toContain('aria-label="3"');

    const between = startingState({ turn: 1, lastTurn: { seat: 0, dice: [5, 4], played: [] } });
    const after = render(GRACE, viewOf({ snapshot: snapshotOf({ state: between }) }));
    expect(after).toContain('aria-label="5, played"');
    expect(after).toContain('aria-label="4, played"');
  });

  it("shows no dice before anybody has rolled", () => {
    expect(render(ADA, viewOf())).not.toContain('aria-label="Dice"');
  });

  it("shows where the selected checker can go, one place per die", () => {
    const state = startingState(moving([6, 3], [{ from: 1, die: 6 }, { from: 1, die: 3 }]));
    const html = render(ADA, viewOf({ snapshot: snapshotOf({ state }), selected: 1 }));

    // The head is 24 for White, so the 6 lands on 18 and the 3 on 21.
    expect(html).toContain("Move to point 18 with the 6");
    expect(html).toContain("Move to point 21 with the 3");
  });

  it("keeps a point's pieces apart from its background, so only the background moves", () => {
    // The 3 from point 1 lands on point 4, where another checker can also move.
    const state = startingState({
      points: [board({ 1: 14, 4: 1 }), board({ 1: 15 })],
      ...moving([3, 2], [{ from: 1, die: 3 }, { from: 4, die: 2 }]),
    });
    const html = render(ADA, viewOf({ snapshot: snapshotOf({ state }), selected: 1 }));

    // Point 4 is 21 in the shared numbering. It has a button to land on, and one for its pieces.
    const landing = html.indexOf('aria-label="Move to point 21 with the 3"');
    const pieces = html.indexOf('aria-label="Move a checker from point 21"');
    expect(landing).toBeGreaterThan(-1);
    expect(pieces).toBeGreaterThan(landing);
    // Nothing of the pieces is inside the button that moves.
    expect(html.slice(landing, pieces)).not.toContain('<circle class="checker ');
  });

  it("offers one plain bear-off button, whichever dice could do it", () => {
    const state = startingState({
      points: [board({ 20: 15 }), board({ 1: 15 })],
      ...moving([6, 5], [{ from: 20, die: 6 }, { from: 20, die: 5 }]),
    });
    const html = render(ADA, viewOf({ snapshot: snapshotOf({ state }), selected: 20 }));

    // Both the 5 and the 6 can bear off the checker on 20, and the button shows neither.
    expect(html.split('aria-label="Bear off"').length - 1).toBe(1);
    expect(html).not.toContain("Bear off with");
    expect(html).not.toContain("off · 5");
    expect(html).not.toContain("off · 6");
  });

  it("offers an undo to the mover once a step is played, and to nobody else", () => {
    const played = [{ from: 1, die: 6 }];
    const state = startingState(moving([6, 3], [{ from: 7, die: 3 }], played, [3]));
    const view = viewOf({ snapshot: snapshotOf({ state }) });

    expect(render(ADA, view)).toMatch(/<button[^>]*>Undo</);
    expect(render(GRACE, view)).not.toContain("Undo");
    expect(render(STRANGER, view)).not.toContain("Undo");
  });

  it("shows the undo where the roll button was, under the dice, and never both", () => {
    const state = startingState(moving([6, 3], [{ from: 7, die: 3 }], [{ from: 1, die: 6 }], [3]));
    const html = render(ADA, viewOf({ snapshot: snapshotOf({ state }) }));

    const wrap = html.slice(html.indexOf('class="board-wrap"'), html.indexOf('aria-label="Turn"'));
    expect(wrap.indexOf("</svg>")).toBeLessThan(wrap.indexOf("Undo"));
    expect(wrap).toMatch(/class="button button-quiet under-dice"[^>]*style="left:65\.56%;top:\d+\.\d+%"/);
    expect(html.slice(html.indexOf('aria-label="Turn"'))).not.toContain("Undo");
    // The roll button comes before the first step and is not there now.
    expect(html).not.toContain("Roll dice");
    // And both sit in the same spot.
    const roll = render(ADA, viewOf());
    const spot = (s: string) => /style="(left:[^"]*)"/.exec(s)?.[1];
    expect(spot(roll)).toBeDefined();
    expect(spot(html)).toBe(spot(roll));
  });

  it("offers no undo before the first step, before the roll, or while a step is on its way", () => {
    const rolled = startingState(moving([6, 3], [{ from: 1, die: 6 }]));
    const midway = startingState(moving([6, 3], [{ from: 7, die: 3 }], [{ from: 1, die: 6 }], [3]));

    expect(render(ADA, viewOf({ snapshot: snapshotOf({ state: rolled }) }))).not.toContain("Undo");
    expect(render(ADA, viewOf())).not.toContain("Undo");
    expect(render(ADA, viewOf({ snapshot: snapshotOf({ state: midway }), busy: true }))).not.toContain("Undo");
  });

  it("offers auto-play to a player, showing whether it is on, and to nobody else", () => {
    expect(render(ADA, viewOf())).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Auto-play</);
    expect(render(GRACE, viewOf({ auto: true }))).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Auto-play</);
    // The opponent's turn is no reason to hide it: it waits for the player's own.
    expect(render(GRACE, viewOf())).toContain("Auto-play");

    expect(render(STRANGER, viewOf())).not.toContain("Auto-play");
    expect(render(null, viewOf())).not.toContain("Auto-play");
  });

  it("offers no auto-play before the game starts or after it ends", () => {
    expect(render(ADA, waiting)).not.toContain("Auto-play");
    const over = startingState({ phase: { type: "over", winner: 0, points: 1 } });
    expect(render(ADA, viewOf({ snapshot: snapshotOf({ state: over }) }))).not.toContain("Auto-play");
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
  /** The points that have checkers on them, by the number printed on them, with how many are drawn. */
  const occupied = (html: string) => {
    const found: Record<string, number> = {};
    // A point's own group is class "point" or "point point-source" and so on; its parts are
    // "point-bg" and "point-pieces", which are not points.
    for (const chunk of html.split(/<g class="point(?=[" ])/).slice(1)) {
      const label = /class="point-number"[^>]*>(\d+)</.exec(chunk)?.[1];
      const drawn = chunk.split('<circle class="checker ').length - 1;
      if (label && drawn > 0) found[label] = drawn;
    }
    return found;
  };

  // Seat 1 is White and has moved a checker to its own point 4. Seat 0 (Black) calls that point 16.
  const state = startingState({
    white: 1,
    points: [board({ 1: 15 }), board({ 1: 14, 4: 1 })],
  });
  const view = viewOf({ snapshot: snapshotOf({ state }) });

  it("numbers the points the same for both players and for a spectator", () => {
    // White's head is 24 and its fourth point 21; Black's head is 12. Every checker is drawn.
    const expected = { 24: 14, 21: 1, 12: 15 };

    expect(occupied(render(GRACE, view))).toEqual(expected);
    expect(occupied(render(ADA, view))).toEqual(expected);
    expect(occupied(render(STRANGER, view))).toEqual(expected);
  });

  it("still draws each player's own head in the top right", () => {
    // The labels agree but the board is turned: your head is where you expect it.
    const topRight = (html: string) => /<g class="point[^"]*"[^>]*>(?:(?!<g class="point)[\s\S])*?x="592" y="18"[^>]*>(\d+)</.exec(html)?.[1];

    expect(topRight(render(GRACE, view))).toBe("24"); // White
    expect(topRight(render(ADA, view))).toBe("12"); // Black
    expect(topRight(render(STRANGER, view))).toBe("24"); // a spectator sees White's side
  });

  it("names the same point in the move buttons", () => {
    const mover = startingState({
      white: 1,
      turn: 1,
      points: [board({ 1: 15 }), board({ 1: 14, 4: 1 })],
      ...moving([3, 2], [{ from: 4, die: 3 }]),
    });
    const html = render(GRACE, viewOf({ snapshot: snapshotOf({ state: mover }) }));

    expect(html).toContain("Move a checker from point 21");
  });
});

describe("the strip along the top", () => {
  const view = viewOf();

  it("has the way back to the games before the title, so it costs no height of its own", () => {
    const html = render(ADA, view);

    expect(html).toContain("← All games");
    expect(html.indexOf("← All games")).toBeLessThan(html.indexOf("Long backgammon"));
    expect(html.indexOf('class="game-top"')).toBeLessThan(html.indexOf("← All games"));
  });

  it("has a volume slider beside it, set to the volume it is given", () => {
    const html = render(ADA, view, { volume: 0.5 });

    expect(html).toMatch(/<input[^>]*type="range"[^>]*value="10"/);
    expect(html).toContain('aria-valuetext="50%"');
    expect(html.indexOf("← All games")).toBeLessThan(html.indexOf('class="volume-slider"'));
  });

  it("calls the slider's left end Off", () => {
    expect(render(ADA, view, { volume: 0 })).toContain('aria-valuetext="Off"');
  });
});
