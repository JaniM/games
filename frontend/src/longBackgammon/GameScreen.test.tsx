import { createDb } from "millpond";
import { DbProvider } from "millpond/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../features/game";
import { GAME_ID, board, moving, snapshotOf, startingState } from "../fixtures";
import { router } from "../features/router";
import { asFrame } from "../features/game/review";
import { GameScreen, type GameScreenProps, type GameViewRow, type ReviewRow } from "./GameScreen";

// Rendering to a string shows the first moment, before the loading text has waited its second.
// This one says it at once, which shows whether the page is waiting (see immediateLoading.tsx).
vi.mock("../Loading", () => import("../immediateLoading"));

// What a page shows is a function of its props, so these render it to a string.
// (There is no DOM here: clicks are covered by the helpers and ops they call.)

const ADA = "user-a";
const GRACE = "user-b";
const STRANGER = "user-x";
const URL = `https://games.test/games/${GAME_ID}`;

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
    queued: [],
    auto: false,
    rematchStarted: null,
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
        rematchRequest={undefined}
        review={undefined}
        inviteUrl={URL}
        onJoin={noop}
        onRematch={noop}
        onDeclineRematch={noop}
        onReview={noop}
        onCloseReview={noop}
        onRetryReview={noop}
        onShowFrame={noop}
        onStepFrame={noop}
        onRoll={noop}
        onUndo={noop}
        onForfeit={noop}
        onAutoplay={noop}
        showAutoplay={true}
        onSelect={noop}
        onMove={noop}
        onCue={noop}
        {...extra}
      />
    </DbProvider>,
  );
}

/**
 * The board and what is laid over it, up to the first section under it (the status, the review
 * or the result), and the rest of the page without it.
 */
function splitBoard(html: string): { wrap: string; elsewhere: string } {
  const from = html.indexOf('class="board-wrap"');
  const to = html.indexOf("<section", from);
  return { wrap: html.slice(from, to), elsewhere: html.slice(0, from) + html.slice(to) };
}

/** The player bars in the order they are on the page: whose each is, and whether it is lit. */
function barsOf(html: string): { text: string; active: boolean }[] {
  return [...html.matchAll(/<div class="player-bar( player-bar-active)?">(.*?)<\/div>/g)].map(
    ([, active, inner]) => ({ active: active !== undefined, text: (inner ?? "").replaceAll(/<[^>]*>/g, "") }),
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
  it("shows a spectator the game, without a join button or roll button", () => {
    const html = render(STRANGER, viewOf());

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

  it("puts the roll button on the board, under the dice, not in the status", () => {
    const { wrap, elsewhere } = splitBoard(render(ADA, viewOf()));

    expect(wrap).toContain("Roll dice");
    // After the board, positioned by percentages of it, centred under the dice.
    expect(wrap.indexOf("</svg>")).toBeLessThan(wrap.indexOf("Roll dice"));
    expect(wrap).toMatch(/class="button under-dice"[^>]*style="left:65\.56%;top:\d+\.\d+%"/);
    expect(elsewhere).not.toContain("Roll dice");
  });

  it("does not offer a second roll while the first is on its way", () => {
    expect(render(ADA, viewOf({ busy: true }))).not.toContain("Roll dice");
  });

  it("names the players and says who is White and who moves", () => {
    const html = render(GRACE, viewOf());

    expect(html).toContain("Grace (you)");
    expect(html).toContain(">Ada<");
    // The colours are said by the swatches. Their names are left for a screen reader.
    expect(html).toContain('<span class="visually-hidden">White</span>');
    expect(html).toContain('<span class="visually-hidden">Black</span>');
    expect(html).not.toContain('class="player-colour"');
  });

  it("leaves \"to move\" out of the bar for the eye, to give the name its room, and keeps it for a screen reader", () => {
    const html = render(GRACE, viewOf());

    expect(html).not.toContain("player-turn");
    expect(html.match(/<span class="visually-hidden">to move<\/span>/g)).toHaveLength(1);
    // It is in the bar that is lit: Ada's, who is White and rolls first.
    expect(barsOf(html).map((bar) => bar.active)).toEqual([false, true]);
    expect(html).toContain(
      '<div class="player-bar player-bar-active"><span class="swatch swatch-white" aria-hidden="true"></span><span class="player-name" title="Ada">Ada</span><span class="visually-hidden">White</span><span class="visually-hidden">to move</span></div>',
    );
  });

  it("puts the whole of a name in its tooltip, for the bar to cut it off", () => {
    const long = "W".repeat(32);
    const html = render(GRACE, viewOf({ snapshot: snapshotOf({ playerNames: ["Ada", long] }) }));

    expect(html).toContain(`title="${long} (you)"`);
    expect(html).toContain(`>${long} (you)</span>`);
  });

  it("puts both bars side by side over the board, the viewer's own first", () => {
    const html = render(GRACE, viewOf());
    const board = html.indexOf('class="board-wrap"');

    // One row, to leave the height to the board: nothing of the players is under it.
    expect(html.match(/class="player-bars"/g)).toHaveLength(1);
    expect(html.lastIndexOf('class="player-bar')).toBeLessThan(board);
    const [first, second] = barsOf(html);
    expect(first?.text).toContain("Grace (you)");
    expect(second?.text).toContain("Ada");
    expect(barsOf(html)).toHaveLength(2);
  });

  it("puts a spectator's view the same way: White first", () => {
    const [first, second] = barsOf(render(STRANGER, viewOf()));

    // Nobody is "you"; the first bar is the one the board is turned for, White's.
    expect(first?.text).toContain("Ada");
    expect(second?.text).toContain("Grace");
  });

  it("highlights the player to move, wherever their bar is", () => {
    // Ada (White, seat 0) is to roll first.
    const ada = barsOf(render(ADA, viewOf()));
    expect(ada.map((bar) => bar.active)).toEqual([true, false]);

    const grace = barsOf(render(GRACE, viewOf()));
    expect(grace.map((bar) => bar.active)).toEqual([false, true]);
  });

  it("highlights nobody when the game is over", () => {
    const state = startingState({ phase: { type: "over", winner: 0, points: 1, forfeited: false } });

    expect(render(ADA, viewOf({ snapshot: snapshotOf({ state }) }))).not.toContain("player-bar-active");
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

  it("puts the undo on the board, between the trays, where it covers no stack", () => {
    const state = startingState(moving([6, 3], [{ from: 7, die: 3 }], [{ from: 1, die: 6 }], [3]));
    const html = render(ADA, viewOf({ snapshot: snapshotOf({ state }) }));
    const { wrap, elsewhere } = splitBoard(html);

    // After the board, positioned by percentages of it: the trays' column, halfway down.
    expect(wrap.indexOf("</svg>")).toBeLessThan(wrap.indexOf("Undo"));
    expect(wrap).toMatch(/class="button button-quiet between-trays"[^>]*style="left:92\.78%;top:50\.00%"/);
    expect(wrap).not.toContain("under-dice");
    expect(elsewhere).not.toContain("Undo");
    // The roll button comes before the first step and is not there now.
    expect(html).not.toContain("Roll dice");
  });

  it("offers nothing to press between the steps of a combined move, which is one move", () => {
    const three = { from: 1, die: 3 };
    const six = { from: 4, die: 6 };
    const state = startingState(moving([3, 6], [six], [three], [6]));

    const between = render(ADA, viewOf({ snapshot: snapshotOf({ state }), queued: [six] }));
    expect(between).not.toContain("Undo");
    expect(between).not.toContain("Move a checker from");
    expect(between).not.toContain("Roll dice");

    // The same position with nothing queued is the mover's to play.
    const idle = render(ADA, viewOf({ snapshot: snapshotOf({ state }) }));
    expect(idle).toContain("Undo");
    expect(idle).toContain("Move a checker from");
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

  it("leaves auto-play out altogether when the page says not to offer it, as in a release build", () => {
    const html = render(ADA, viewOf(), { showAutoplay: false });

    expect(html).not.toContain("Auto-play");
    // The rest of the controls are still there.
    expect(html).toContain('aria-label="Turn"');
  });

  it("offers no auto-play before the game starts or after it ends", () => {
    expect(render(ADA, waiting)).not.toContain("Auto-play");
    const over = startingState({ phase: { type: "over", winner: 0, points: 1, forfeited: false } });
    expect(render(ADA, viewOf({ snapshot: snapshotOf({ state: over }) }))).not.toContain("Auto-play");
  });

  it("marks an opponent who is a guest, and no one else", () => {
    const guests = viewOf({ snapshot: snapshotOf({ playerGuests: [true, true] }) });

    // Ada is seat 0, and sees herself as she is.
    const ada = render(ADA, guests);
    expect(ada).toContain("Grace (guest)");
    expect(ada).toContain("Ada (you)");
    expect(ada).not.toContain("Ada (guest)");
    // A spectator sees both marked.
    const spectator = render(STRANGER, guests);
    expect(spectator).toContain("Ada (guest)");
    expect(spectator).toContain("Grace (guest)");
    // And with accounts, nobody is.
    expect(render(ADA, viewOf())).not.toContain("(guest)");
  });

  it("names a guest who has won, in the result", () => {
    const state = startingState({ phase: { type: "over", winner: 1, points: 1, forfeited: false } });
    const html = render(ADA, viewOf({ snapshot: snapshotOf({ state, playerGuests: [true, true] }) }));

    expect(html).toContain(">Grace (guest) won<");
  });

  it("offers a player a way to forfeit, on their own turn and on the other's, and nobody else", () => {
    expect(render(ADA, viewOf())).toMatch(/<button[^>]*>Forfeit</);
    // Giving up is not a move: it doesn't wait for the player's turn.
    expect(render(GRACE, viewOf())).toMatch(/<button[^>]*>Forfeit</);

    expect(render(STRANGER, viewOf())).not.toContain("Forfeit");
    expect(render(null, viewOf())).not.toContain("Forfeit");
  });

  it("offers no forfeit before the game starts or after it ends", () => {
    expect(render(ADA, waiting)).not.toContain("Forfeit");
    const over = startingState({ phase: { type: "over", winner: 0, points: 1, forfeited: false } });
    expect(render(ADA, viewOf({ snapshot: snapshotOf({ state: over }) }))).not.toContain("Forfeit");
  });

  it("holds the forfeit back while an action waits for its answer, or the connection is down", () => {
    expect(render(ADA, viewOf())).not.toMatch(/<button[^>]*disabled[^>]*>Forfeit</);
    expect(render(ADA, viewOf({ busy: true }))).toMatch(/<button[^>]*disabled[^>]*>Forfeit</);
    expect(render(ADA, viewOf({ connection: "reconnecting" }))).toMatch(/<button[^>]*disabled[^>]*>Forfeit</);
  });

  it("asks nothing yet: the question comes with the press", () => {
    expect(render(ADA, viewOf())).not.toContain("Forfeit this game?");
  });

  it("shows who gave up, instead of what the win is worth", () => {
    const state = startingState({ phase: { type: "over", winner: 0, points: 1, forfeited: true } });
    const html = render(ADA, viewOf({ snapshot: snapshotOf({ state }) }));

    expect(html).toContain(">You won<");
    expect(html).toContain(">Grace forfeited<");
    expect(html).not.toContain(">1 point<");
    expect(html).toContain('class="result result-won"');
  });

  it("shows the other player what happened, as the one who gave up", () => {
    const state = startingState({ phase: { type: "over", winner: 0, points: 1, forfeited: true } });
    const html = render(GRACE, viewOf({ snapshot: snapshotOf({ state }) }));

    expect(html).toContain(">Ada won<");
    expect(html).toContain(">You forfeited<");
    expect(html).not.toContain('class="result result-won"');
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

  it("warns about the last throw, and does not recount the last turn", () => {
    const state = startingState({
      turn: 1,
      lastThrow: true,
      lastTurn: { seat: 0, dice: [6, 5], played: [] },
    });
    const html = render(GRACE, viewOf({ snapshot: snapshotOf({ state }) }));

    expect(html).not.toContain("rolled 6-5");
    expect(html).toContain("White has borne off everything. Black gets one last throw.");
  });

  it("shows the result when the game is over, and no one to move", () => {
    const state = startingState({
      off: [15, 3],
      phase: { type: "over", winner: 0, points: 1, forfeited: false },
    });
    const html = render(GRACE, viewOf({ snapshot: snapshotOf({ state }) }));

    expect(html).toContain('aria-label="Result"');
    expect(html).toContain("Game over");
    expect(html).toContain(">Ada won<");
    expect(html).toContain(">1 point<");
    expect(html).not.toContain('class="result result-won"');
    expect(html).not.toContain("to move");
    expect(html).not.toContain("Roll dice");
  });

  it("replaces the status with the result, and offers a rematch", () => {
    const state = startingState({ phase: { type: "over", winner: 0, points: 2, forfeited: false } });
    const html = render(ADA, viewOf({ snapshot: snapshotOf({ state }) }));

    expect(html).not.toContain('aria-label="Turn"');
    expect(html).toContain('class="result result-won"');
    expect(html).toContain(">You won<");
    expect(html).toContain(">Mars: 2 points<");
    expect(html).toContain(">Rematch<");
    // The nav is the way out: the result has no button for it.
    expect(html).not.toContain("All games");
  });

  it("has no buttons in the result of someone who is only watching", () => {
    const state = startingState({ phase: { type: "over", winner: 0, points: 1, forfeited: false } });
    const html = render(STRANGER, viewOf({ snapshot: snapshotOf({ state }) }));

    expect(html).toContain('class="result"');
    expect(html).not.toContain("result-actions");
    expect(html).not.toContain("All games");
  });

  it("marks the status as the viewer's own while it is their move, and not otherwise", () => {
    expect(render(ADA, viewOf())).toContain('data-turn="mine"');
    expect(render(GRACE, viewOf())).toContain('data-turn="wait"');
    expect(render(STRANGER, viewOf())).toContain('data-turn="wait"');
  });

  it("puts a lost connection in the status, where it moves nothing", () => {
    const html = render(ADA, viewOf({ connection: "reconnecting" }));

    expect(html).toMatch(/status-detail status-detail-alert"><span role="alert">Connection lost\. Reconnecting…/);
  });

  it("puts the status under the board, after both player bars", () => {
    const html = render(ADA, viewOf());

    expect(html.indexOf('aria-label="Turn"')).toBeGreaterThan(html.indexOf('class="board-wrap"'));
    expect(html.indexOf('aria-label="Turn"')).toBeGreaterThan(html.lastIndexOf('class="player-bar'));
  });

  it("puts the result there too, in the place of the status", () => {
    const over = startingState({ phase: { type: "over", winner: 0, points: 1, forfeited: false } });
    const html = render(ADA, viewOf({ snapshot: snapshotOf({ state: over }) }));

    expect(html.indexOf('aria-label="Result"')).toBeGreaterThan(html.lastIndexOf('class="player-bar'));
    expect(html).not.toContain('aria-label="Turn"');
  });

  it("leaves out the line under the turn when there is nothing to say", () => {
    // Nobody has played, nothing is wrong, and the game has started.
    expect(render(ADA, viewOf())).not.toContain("status-detail");
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
  /** The points, by their number (nothing is printed on the board, but each point carries it), with their markup. */
  const pointsOf = (html: string) =>
    // A point's own group is class "point" or "point point-source" and so on; its parts are
    // "point-bg" and "point-pieces", which are not points.
    html
      .split(/<g class="point(?=[" ])/)
      .slice(1)
      .map((chunk) => ({ number: /data-point="(\d+)"/.exec(chunk)?.[1], chunk }));

  /** The points that have checkers on them, by number, with how many are drawn. */
  const occupied = (html: string) => {
    const found: Record<string, number> = {};
    for (const { number, chunk } of pointsOf(html)) {
      const drawn = chunk.split('<circle class="checker ').length - 1;
      if (number && drawn > 0) found[number] = drawn;
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
    // The numbers agree but the board is turned: your head is where you expect it. The point in
    // the top right corner is the one whose triangle has its base from x = 568 along the top.
    const topRight = (html: string) =>
      pointsOf(html).find(({ chunk }) => chunk.includes('d="M568,28 '))?.number;

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

describe("the top of the page", () => {
  const view = viewOf();

  it("shows no title: the nav says where you are, and only a screen reader gets one", () => {
    const html = render(ADA, view);

    expect(html).toContain('<h1 class="visually-hidden">Long backgammon</h1>');
    expect(html).not.toContain("game-head");
    expect(html).not.toContain("game-title");
  });

  it("has no strip of its own: the nav and the account menu are the page's, not the game's", () => {
    const html = render(ADA, view);

    expect(html).not.toContain("game-top");
    expect(html).not.toContain("← All games");
    expect(html).not.toContain("Options");
  });

  it("has no volume slider: it is in the account menu", () => {
    const html = render(ADA, view);

    expect(html).not.toContain("volume");
    expect(html).not.toContain("type=\"range\"");
  });

  it("does not say a viewer is watching, to a viewer or to a player: the board is the same", () => {
    for (const html of [render(STRANGER, view), render(ADA, view)]) {
      expect(html).not.toContain("You are watching this game");
      expect(html).not.toContain("game-caption");
    }
  });
});

describe("the rematch of a finished game", () => {
  const over = startingState({ phase: { type: "over", winner: 0, points: 1, forfeited: false } });
  const finished = (rematch: Snapshot["rematch"] = null, overrides: Partial<GameViewRow> = {}) =>
    viewOf({ snapshot: snapshotOf({ state: over, rematch }), ...overrides });
  /** The buttons about the rematch: the review is another matter (see "reviewing a game"). */
  const buttons = (html: string) =>
    [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)]
      .map((match) => match[1])
      .filter((label) => label !== "Review game");
  /** The result block, which is where all of it is. */
  const resultOnly = (html: string) => html.slice(html.indexOf('aria-label="Result"'));

  it("offers a player the rematch beside the way back", () => {
    const html = resultOnly(render(ADA, finished()));

    expect(buttons(html)).toEqual(["Rematch"]);
    expect(html).toMatch(/<button[^>]*class="button"[^>]*>Rematch</);
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });

  it("offers a spectator nothing to press", () => {
    const html = resultOnly(render(STRANGER, finished()));

    expect(buttons(html)).toEqual([]);
    expect(html).not.toContain("<a ");
  });

  it("offers nothing before the game is over", () => {
    const html = render(ADA, viewOf());

    expect(html).not.toContain("Rematch");
    expect(html).not.toContain("result-rematch");
  });

  it("tells the one who asked to wait, and lets them take it back", () => {
    const html = resultOnly(render(ADA, finished({ type: "offered", by: 0 })));

    expect(html).toContain("Waiting for Grace to accept the rematch…");
    expect(buttons(html)).toEqual(["Cancel"]);
    expect(html).not.toContain("result-rematch-due");
  });

  it("asks the other player for an answer, in the accent because it is theirs to give", () => {
    const html = resultOnly(render(GRACE, finished({ type: "offered", by: 0 })));

    expect(html).toMatch(/class="result-rematch result-rematch-due"[^>]*>Ada wants a rematch\./);
    expect(buttons(html)).toEqual(["Accept", "Decline"]);
    expect(html).toMatch(/<button[^>]*class="button"[^>]*>Accept</);
    expect(html).toMatch(/<button[^>]*class="button button-quiet"[^>]*>Decline</);
  });

  it("tells the one who was turned down, and lets them ask again", () => {
    const html = resultOnly(render(ADA, finished({ type: "declined", by: 0 })));

    expect(html).toContain("Grace declined the rematch.");
    expect(buttons(html)).toEqual(["Rematch"]);
  });

  it("says nothing to the one who turned the offer down, who can still ask", () => {
    const html = resultOnly(render(GRACE, finished({ type: "declined", by: 0 })));

    expect(html).not.toContain("declined");
    expect(buttons(html)).toEqual(["Rematch"]);
  });

  it("links everyone, spectators too, to the new game once it exists", () => {
    for (const userId of [ADA, GRACE, STRANGER]) {
      const html = resultOnly(render(userId, finished({ type: "accepted", gameId: "nextgame234" })));

      expect(html).toContain("The rematch has started.");
      expect(html).toMatch(/<a[^>]*class="button"[^>]*href="\/games\/nextgame234"[^>]*>Go to the rematch</);
      expect(buttons(html)).toEqual([]);
    }
  });

  it("holds the buttons back while an answer is on its way, so that pressing twice answers once", () => {
    const sending = { gameId: GAME_ID, answer: "ask", state: "sending", error: null } as const;

    const asking = resultOnly(render(ADA, finished(), { rematchRequest: sending }));
    const answering = resultOnly(render(GRACE, finished({ type: "offered", by: 0 }), { rematchRequest: sending }));

    expect(asking).toMatch(/<button[^>]*disabled[^>]*>Rematch</);
    expect(answering).toMatch(/<button[^>]*disabled[^>]*>Accept</);
    expect(answering).toMatch(/<button[^>]*disabled[^>]*>Decline</);
  });

  it("holds the buttons back while the connection is down, as the join button is", () => {
    const html = resultOnly(render(ADA, finished(null, { connection: "reconnecting" })));

    expect(html).toMatch(/<button[^>]*disabled[^>]*>Rematch</);
  });

  it("says why an answer failed, as an alert", () => {
    const failed = { gameId: GAME_ID, answer: "ask", state: "failed", error: "The game is not over yet." } as const;

    const html = resultOnly(render(ADA, finished(), { rematchRequest: failed }));

    expect(html).toMatch(/role="alert">The game is not over yet\./);
    // And it can be tried again.
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });

  it("keeps the size of the block when an answer fails: the problem takes the place of the rematch line", () => {
    const failed = { gameId: GAME_ID, answer: "ask", state: "failed", error: "Try again." } as const;

    const html = resultOnly(render(GRACE, finished({ type: "offered", by: 0 }), { rematchRequest: failed }));

    // A screen reader still has the line it had. On the screen there is one line for the rematch.
    expect(html).toMatch(/class="result-rematch visually-hidden"[^>]*>Ada wants a rematch\./);
    expect(html).toMatch(/class="result-rematch result-rematch-due"[^>]*>Try again\./);
    expect(html.match(/class="result-rematch(?! visually-hidden)/g)).toHaveLength(1);
  });
});

describe("reviewing a game", () => {
  // Ada (seat 0) is White. A short game: the start, a roll, a step, the turn passing on.
  const rolled = startingState(moving([6, 3], [{ from: 1, die: 6 }]));
  const afterSix = startingState({
    points: [board({ 1: 14, 7: 1 }), board({ 1: 15 })],
    ...moving([6, 3], [{ from: 7, die: 3 }], [{ from: 1, die: 6 }], [3]),
  });
  const turnOver = startingState({
    turn: 1,
    turns: [1, 0],
    points: [board({ 1: 14, 10: 1 }), board({ 1: 15 })],
    lastTurn: { seat: 0, dice: [6, 3], played: [{ from: 1, die: 6 }, { from: 7, die: 3 }] },
  });
  const over = startingState({
    off: [15, 2],
    turns: [41, 40],
    phase: { type: "over", winner: 0, points: 1, forfeited: false },
    lastTurn: { seat: 0, dice: [1, 2], played: [{ from: 24, die: 1 }] },
  });

  const reviewOf = (overrides: Partial<ReviewRow> = {}): ReviewRow => ({
    gameId: GAME_ID,
    load: "ready",
    error: null,
    frames: [asFrame(1, startingState()), asFrame(2, rolled), asFrame(3, afterSix), asFrame(4, turnOver)],
    through: 4,
    at: null,
    ...overrides,
  });
  /** The game as it stands: seat 1 is about to roll, and the review is on it. */
  const live = viewOf({ snapshot: snapshotOf({ revision: 4, state: turnOver }) });
  /** The opening tag of a control of the review, by its label. */
  const control = (html: string, label: string) =>
    html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
  /** Server rendering marks where one piece of text ends and the next begins, which a reader does not see. */
  const plain = (html: string) => html.replaceAll("<!-- -->", "");
  const panel = (html: string) => plain(html).slice(plain(html).indexOf('aria-label="Review"'));

  describe("starting", () => {
    it("is not offered at the end of a game, to anyone: the review is always there", () => {
      const finished = viewOf({ snapshot: snapshotOf({ state: over }) });

      for (const userId of [ADA, GRACE, STRANGER]) {
        const html = render(userId, finished);

        expect(html).not.toContain("Review game");
        expect(html).not.toContain("Review moves");
      }
    });

    it("is offered in the status of a game in progress, to a player", () => {
      for (const userId of [ADA, GRACE]) {
        const html = render(userId, live);

        expect(html).toMatch(/<button[^>]*>Review moves</);
        expect(html).not.toContain("Review game");
        expect(html).not.toContain('aria-label="Review"');
      }
    });

    it("is not offered to a spectator of a game in progress: the review is always there", () => {
      expect(render(STRANGER, live)).not.toContain("Review moves");
    });

    it("is not offered before anything has been played: there is nothing to step through", () => {
      expect(render(ADA, viewOf())).not.toContain("Review");
    });

    it("is not offered while the game waits for a player", () => {
      expect(render(ADA, waiting)).not.toContain("Review");
    });
  });

  describe("on the board", () => {
    it("takes the place of the status of a game in progress", () => {
      const html = render(ADA, live, { review: reviewOf() });

      expect(html).toContain('aria-label="Review"');
      expect(html).not.toContain('aria-label="Turn"');
      expect(html).not.toContain("Review moves");
    });

    it("goes above the result of a game that is over, which keeps the rematch", () => {
      const finished = viewOf({ snapshot: snapshotOf({ state: over }) });

      const html = render(ADA, finished, { review: reviewOf({ frames: [asFrame(9, over)] }) });

      expect(html).toContain('aria-label="Review"');
      expect(html).toContain('aria-label="Result"');
      expect(html.indexOf('aria-label="Review"')).toBeLessThan(html.indexOf('aria-label="Result"'));
      expect(html).toContain("Rematch");
    });

    it("can't be closed when it is always there: for a game that is over, and for a watcher", () => {
      const finished = viewOf({ snapshot: snapshotOf({ state: over }) });
      const frames = [asFrame(1, startingState()), asFrame(9, over)];

      for (const userId of [ADA, GRACE, STRANGER]) {
        expect(render(userId, finished, { review: reviewOf({ frames }) })).not.toContain("Close review");
      }
      expect(render(STRANGER, live, { review: reviewOf() })).not.toContain("Close review");
    });

    it("has no foot where there is nothing to say in it: a finished game has no turn, and no way back", () => {
      const finished = viewOf({ snapshot: snapshotOf({ revision: 9, state: over }) });
      const frames = [asFrame(1, startingState()), asFrame(9, over)];

      expect(render(ADA, finished, { review: reviewOf({ frames }) })).not.toContain("review-foot");
    });

    it("still says what the game is waiting for, to a watcher of a game in progress", () => {
      const html = panel(render(STRANGER, live, { review: reviewOf() }));

      expect(html).toContain("In the game: Waiting for Grace to roll.");
      expect(html).not.toContain("Close review");
    });

    it("shows the bar while the positions of a game that is always reviewed are on their way", () => {
      const loading = reviewOf({ load: "loading", frames: [], through: -1 });

      expect(panel(render(STRANGER, live, { review: loading }))).toContain("Loading the moves…");
    });

    it("shows nothing for a game that is always reviewed and has no positions kept: the result is enough", () => {
      const finished = viewOf({ snapshot: snapshotOf({ state: over }) });

      const html = render(ADA, finished, { review: reviewOf({ frames: [], through: -1 }) });

      expect(html).not.toContain('aria-label="Review"');
      expect(html).not.toContain("Nothing was kept of this game.");
      expect(html).toContain('aria-label="Result"');
    });

    it("shows no title of its own: only the bar, with what led to each position kept for a screen reader", () => {
      const html = render(ADA, live, { review: reviewOf({ at: 1 }) });

      expect(html).not.toContain("review-kicker");
      expect(html).toMatch(/<p class="review-title visually-hidden"[^>]*>You rolled 6-3</);
    });

    it("shows the newest position when the review opens, which is the game as it stands", () => {
      const html = panel(render(STRANGER, live, { review: reviewOf() }));

      expect(html).toContain("Ada played 18→15");
      expect(html).toContain("4 / 4");
    });

    it("shows the position that was picked, with what led to it", () => {
      const html = panel(render(STRANGER, live, { review: reviewOf({ at: 1 }) }));

      expect(html).toContain("Ada rolled 6-3");
      expect(html).toContain("2 / 4");
      expect(render(STRANGER, live, { review: reviewOf({ at: 0 }) })).toContain("Start of the game");
    });

    it("calls the viewer \"You\" in what it says, as the rest of the page does", () => {
      expect(panel(render(ADA, live, { review: reviewOf({ at: 1 }) }))).toContain("You rolled 6-3");
      expect(panel(render(GRACE, live, { review: reviewOf({ at: 1 }) }))).toContain("Ada rolled 6-3");
    });

    it("draws the position picked in the bars over and under the board, not the game as it stands", () => {
      const ended = viewOf({ snapshot: snapshotOf({ revision: 9, state: over }) });
      const frames = [asFrame(1, startingState()), asFrame(9, over)];

      expect(plain(render(ADA, ended, { review: reviewOf({ frames, at: 0 }) }))).not.toContain('class="player-off"');
      expect(plain(render(ADA, ended, { review: reviewOf({ frames, at: null }) }))).toContain("15 borne off</span>");
    });

    it("moves who is to move with the position", () => {
      const forFrame = (at: number | null) => render(ADA, live, { review: reviewOf({ at }) });

      // In the game seat 1 (Grace) is to roll; in the position after the roll, seat 0 (Ada) is to move.
      // Ada is the viewer, so her bar is the first.
      expect(barsOf(forFrame(null)).map((bar) => bar.active)).toEqual([false, true]);
      expect(barsOf(forFrame(1)).map((bar) => bar.active)).toEqual([true, false]);
    });

    it("lets nothing be played, even on the player's own turn", () => {
      const mine = viewOf({ snapshot: snapshotOf({ revision: 4, state: startingState() }) });
      expect(render(ADA, mine)).toContain("Roll dice");

      const html = render(ADA, mine, { review: reviewOf() });

      expect(html).not.toContain("Roll dice");
      expect(html).not.toContain(">Undo<");
    });

    it("says what the game is waiting for, so that a player's turn is not missed", () => {
      const mine = viewOf({ snapshot: snapshotOf({ revision: 4, state: startingState() }) });

      expect(panel(render(ADA, mine, { review: reviewOf() }))).toContain("In the game: Your turn. Roll the dice.");
      expect(panel(render(GRACE, mine, { review: reviewOf() }))).toContain("In the game: Waiting for Ada to roll.");
    });

    it("says no such thing once the game is over", () => {
      const ended = viewOf({ snapshot: snapshotOf({ revision: 9, state: over }) });

      expect(panel(render(ADA, ended, { review: reviewOf({ frames: [asFrame(9, over)] }) }))).not.toContain(
        "In the game",
      );
    });

    it("gives the result with the last position", () => {
      const ended = viewOf({ snapshot: snapshotOf({ revision: 9, state: over }) });
      const frames = [asFrame(1, startingState()), asFrame(9, over)];

      const html = panel(render(ADA, ended, { review: reviewOf({ frames }) }));

      expect(html).toContain("You played 1→off");
      expect(html).toContain("Game over. You won, 1 point.");
    });

    it("does not show the result in the review, but keeps it for a screen reader", () => {
      const ended = viewOf({ snapshot: snapshotOf({ revision: 9, state: over }) });
      const frames = [asFrame(1, startingState()), asFrame(9, over)];

      const html = plain(render(ADA, ended, { review: reviewOf({ frames }) }));

      expect(html).toContain('<p class="review-detail visually-hidden">Game over. You won, 1 point.</p>');
    });
  });

  describe("the controls", () => {
    it("can go back but not on from the newest position", () => {
      const html = render(ADA, live, { review: reviewOf() });

      expect(control(html, "First position")).not.toContain("disabled");
      expect(control(html, "Previous position")).not.toContain("disabled");
      expect(control(html, "Next position")).toContain("disabled");
      expect(control(html, "Latest position")).toContain("disabled");
    });

    it("can go on but not back from the first", () => {
      const html = render(ADA, live, { review: reviewOf({ at: 0 }) });

      expect(control(html, "First position")).toContain("disabled");
      expect(control(html, "Previous position")).toContain("disabled");
      expect(control(html, "Next position")).not.toContain("disabled");
      expect(control(html, "Latest position")).not.toContain("disabled");
    });

    it("has a slider over all the positions, set to the one shown", () => {
      const html = render(ADA, live, { review: reviewOf({ at: 2 }) });

      expect(html).toMatch(/<input[^>]*type="range"[^>]*min="0"[^>]*max="3"[^>]*value="2"/);
      expect(html).toContain('aria-valuetext="3 of 4"');
    });

    it("is held back with a single position, when there is nowhere to go", () => {
      const html = render(ADA, live, { review: reviewOf({ frames: [asFrame(4, turnOver)] }) });

      expect(plain(html)).toContain("1 / 1");
      for (const label of ["First position", "Previous position", "Next position", "Latest position"]) {
        expect(control(html, label)).toContain("disabled");
      }
      expect(html).toMatch(/<input[^>]*type="range"[^>]*disabled/);
    });

    it("always has the way back to the game", () => {
      for (const review of [reviewOf(), reviewOf({ load: "loading", frames: [] }), reviewOf({ load: "failed", error: "No." })]) {
        expect(panel(render(ADA, live, { review }))).toContain("Close review");
      }
    });
  });

  describe("while the positions are on their way", () => {
    const loading = reviewOf({ load: "loading", frames: [], through: -1 });

    it("says so, and shows the game as it stands", () => {
      const html = panel(render(ADA, live, { review: loading }));

      expect(html).toContain("Loading the moves…");
      expect(html).not.toContain("Next position");
    });

    it("lets nothing be played", () => {
      const mine = viewOf({ snapshot: snapshotOf({ revision: 4, state: startingState() }) });

      expect(render(ADA, mine, { review: loading })).not.toContain("Roll dice");
    });

    it("keeps the positions it has when it asks again", () => {
      const html = panel(render(ADA, live, { review: reviewOf({ load: "loading" }) }));

      expect(html).toContain("You played 18→15");
      expect(html).not.toContain("Loading the moves…");
    });
  });

  describe("when the positions could not be had", () => {
    const failed = reviewOf({ load: "failed", error: "Something went wrong on the server. Try again.", frames: [], through: -1 });

    it("says why, as an alert, and offers to try again", () => {
      const html = panel(render(ADA, live, { review: failed }));

      expect(html).toMatch(/role="alert">Something went wrong on the server\. Try again\./);
      expect(html).toMatch(/<button[^>]*>Try again</);
      expect(html).not.toContain("Loading the moves…");
      expect(html).not.toContain("Nothing was kept");
    });

    it("offers nothing to try again when nothing failed", () => {
      expect(panel(render(ADA, live, { review: reviewOf() }))).not.toContain("Try again");
    });
  });

  describe("a game that was not kept", () => {
    it("says that nothing was kept when there are no positions at all", () => {
      const html = panel(render(ADA, live, { review: reviewOf({ frames: [], through: -1 }) }));

      expect(html).toContain("Nothing was kept of this game.");
    });

    it("says that what came before the first position was not kept, when it is not the beginning", () => {
      const finished = viewOf({ snapshot: snapshotOf({ revision: 30, state: over }) });
      const html = panel(render(ADA, finished, { review: reviewOf({ frames: [asFrame(30, over)] }) }));

      expect(html).toContain("What was played before this position was not kept.");
    });

    it("says nothing of the kind for a game that is kept from its start", () => {
      expect(panel(render(ADA, live, { review: reviewOf() }))).not.toContain("not kept");
    });
  });
});
