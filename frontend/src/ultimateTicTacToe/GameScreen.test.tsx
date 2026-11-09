import { createDb } from "millpond";
import { DbProvider } from "millpond/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { asUtttFrame } from "../features/game/review";
import { router } from "../features/router";
import { GAME_ID, marks, utttSnapshotOf, utttState, wonBoard } from "../fixtures";
import { GameScreen, type GameScreenProps, type GameViewRow, isUtttView } from "./GameScreen";

// What a page shows is a function of its props, so these render it to a string.
// (There is no DOM here: clicks are covered by the board's tests and the ops they call.)

const ADA = "user-a"; // seat 0, plays X
const GRACE = "user-b"; // seat 1, plays O
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
    snapshot: utttSnapshotOf(),
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
        onForfeit={noop}
        onAutoplay={noop}
        showAutoplay={true}
        onPlay={noop}
        onCue={noop}
        {...extra}
      />
    </DbProvider>,
  );
}

const count = (html: string, text: string) => html.split(text).length - 1;
/** The cells that can be pressed. */
const pressable = (html: string) => count(html, 'class="ttt-cell ttt-cell-open"');

/** Ada (X) has marked cell 5 of board 1, which sends Grace (O) to board 5. */
const sentToCentre = utttState({
  turn: 1,
  last: { seat: 0, board: 0, cell: 4 },
  cells: marks({ 0: { 4: 0 } }),
  playable: [4],
});
/** The same, one mark on: Ada is to play in board 1 again. */
const backToStart = utttState({
  turn: 0,
  last: { seat: 1, board: 4, cell: 0 },
  cells: marks({ 0: { 4: 0 }, 4: { 0: 1 } }),
  playable: [0],
});
const gameOn = (state = sentToCentre) => viewOf({ snapshot: utttSnapshotOf({ state }) });
const finished = (winner: 0 | 1 | null, forfeited = false) =>
  utttState({
    phase: { type: "over", winner, forfeited },
    last: { seat: 0, board: 4, cell: 2 },
    cells: marks({ 0: wonBoard(0), 4: wonBoard(0), 8: wonBoard(0) }),
    line: winner === 0 && !forfeited ? [0, 4, 8] : null,
  });

/** A game with Ada waiting alone for an opponent. */
const waiting = viewOf({
  snapshot: utttSnapshotOf({ players: [ADA], playerNames: ["Ada"], state: null }),
});

describe("the page", () => {
  it("has a title for a screen reader only, and the square shape", () => {
    const html = render(ADA, gameOn());

    expect(html).toContain('<h1 class="visually-hidden">Ultimate tic-tac-toe</h1>');
    expect(html).toContain('class="page game-page game-page-square"');
  });

  it("is told apart from a long backgammon game by its kind", () => {
    expect(isUtttView(gameOn())).toBe(true);
    expect(isUtttView(waiting)).toBe(true);
    expect(isUtttView({ ...gameOn(), snapshot: { ...utttSnapshotOf(), kind: "long-backgammon" } as never })).toBe(false);
  });
});

describe("a page with no game to show", () => {
  it("says it is connecting, before the first snapshot", () => {
    expect(render(ADA, undefined)).toContain("Connecting to the game…");
    expect(render(ADA, viewOf({ snapshot: null }))).toContain("Connecting to the game…");
  });

  it("says there is no game when the server has none", () => {
    expect(render(ADA, viewOf({ snapshot: null, connection: "missing" }))).toContain("There is no game at this link");
  });

  it("says why a game can't be shown", () => {
    const html = render(ADA, viewOf({ snapshot: null, problem: "This game needs a newer version of the site." }));

    expect(html).toContain("This game needs a newer version of the site.");
    expect(html).not.toContain("ttt-board");
  });
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

  it("shows an empty board with nothing to press, and says who plays X is not decided", () => {
    const html = render(ADA, waiting);

    expect(count(html, 'class="ttt-board ')).toBe(9);
    expect(pressable(html)).toBe(0);
    expect(html).toContain("Waiting for an opponent to join.");
    expect(html).toContain("Who plays X and moves first is decided when the second player joins.");
  });

  it("offers a visitor a button to join, not the invite", () => {
    const html = render(STRANGER, waiting);

    expect(html).toContain("Join game");
    expect(html).not.toContain("Copy link");
  });

  it("shows a join that is on its way, and one that failed", () => {
    const joining = render(STRANGER, waiting, { join: { gameId: GAME_ID, state: "joining", error: null } });
    const failed = render(STRANGER, waiting, { join: { gameId: GAME_ID, state: "failed", error: "Both seats are taken." } });

    expect(joining).toContain("Joining…");
    expect(failed).toContain("Could not join: Both seats are taken.");
  });

  it("offers neither the forfeit nor the review: there is no game yet", () => {
    const html = render(ADA, waiting);

    expect(html).not.toContain("Forfeit");
    expect(html).not.toContain("Review moves");
  });

  it("does not offer auto-play before there is a game", () => {
    expect(render(ADA, waiting)).not.toContain("Auto-play");
  });
});

describe("the player bars", () => {
  it("put the opponent over the board and the viewer under it, each with their mark", () => {
    const html = render(ADA, gameOn());

    const above = html.indexOf("player-bar-above");
    const board = html.indexOf('class="ttt"');
    const below = html.indexOf("player-bar-below");
    expect(above).toBeGreaterThan(-1);
    expect(above).toBeLessThan(board);
    expect(board).toBeLessThan(below);
    expect(html.slice(above, board)).toContain("Grace");
    expect(html.slice(above, board)).toContain("ttt-mark-o");
    expect(html.slice(below)).toContain("Ada (you)");
    expect(html.slice(below)).toContain("ttt-mark-x");
  });

  it("leave the name of each mark for a screen reader: the marks say it to the eye", () => {
    const html = render(ADA, gameOn());
    const above = html.slice(html.indexOf("player-bar-above"), html.indexOf('class="ttt"'));
    const below = html.slice(html.indexOf("player-bar-below"));

    expect(above).toContain('<span class="visually-hidden">O</span>');
    expect(below).toContain('<span class="visually-hidden">X</span>');
    expect(html).not.toContain('class="player-colour"');
  });

  it("mark the player to move, and nobody once the game is over", () => {
    const html = render(ADA, gameOn());
    expect(count(html, "to move")).toBe(1);
    expect(html.slice(html.indexOf("player-bar-above"), html.indexOf('class="ttt"'))).toContain("player-bar-active");

    expect(count(render(ADA, gameOn(finished(0))), "player-bar-active")).toBe(0);
  });

  it("count the small boards each holds, and say nothing of none", () => {
    const state = utttState({
      turn: 1,
      last: { seat: 0, board: 0, cell: 4 },
      cells: marks({ 0: wonBoard(0), 1: wonBoard(0, [3, 4, 5]), 2: wonBoard(1) }),
    });
    const html = render(ADA, gameOn(state));

    expect(html).toContain("2 boards");
    expect(html).toContain("1 board<");
    expect(render(ADA, gameOn())).not.toContain("boards<");
  });

  it("turn to the player X for someone who only watches, with X under the board", () => {
    const html = render(STRANGER, gameOn());

    expect(html.slice(html.indexOf("player-bar-below"))).toContain("Ada");
    expect(html.slice(html.indexOf("player-bar-above"), html.indexOf('class="ttt"'))).toContain("Grace");
  });

  it("show the mark of whoever plays X, when it is the other seat", () => {
    const html = render(ADA, gameOn(utttState({ ...sentToCentre, x: 1, turn: 0 })));

    expect(html.slice(html.indexOf("player-bar-below"))).toContain("ttt-mark-o");
  });
});

describe("the status under the board", () => {
  it("tells the player to move where to play, and is tinted", () => {
    const html = render(GRACE, gameOn());

    expect(html).toContain("Your turn. Play in the highlighted board.");
    expect(html).toContain('data-turn="mine"');
  });

  it("tells the player to move that they may play anywhere at the start", () => {
    expect(render(ADA, viewOf())).toContain("Your turn. Play anywhere.");
  });

  it("waits for the other player, by name", () => {
    const html = render(ADA, gameOn());

    expect(html).toContain("Waiting for Grace to play.");
    expect(html).toContain('data-turn="wait"');
  });

  it("says the same to someone who watches, who has no turn", () => {
    const html = render(STRANGER, gameOn());

    expect(html).toContain("Waiting for Grace to play.");
    expect(html).toContain('data-turn="wait"');
  });

  it("shows what went wrong before anything else, and that the connection is gone", () => {
    expect(render(GRACE, gameOn_({ error: "that cell is taken" }))).toContain("that cell is taken");
    const dropped = render(GRACE, gameOn_({ connection: "reconnecting" }));
    expect(dropped).toContain("Connection lost. Reconnecting…");
  });
});

/** A game on, with a change to the page's row. */
function gameOn_(overrides: Partial<GameViewRow>) {
  return { ...gameOn(), ...overrides };
}

describe("when the player may press a cell", () => {
  it("is on their turn, in the board they were sent to", () => {
    const html = render(GRACE, gameOn());

    expect(pressable(html)).toBe(9);
    expect(count(html, "ttt-board-yours")).toBe(1);
  });

  it("is anywhere that is open at the start of the game", () => {
    expect(pressable(render(ADA, viewOf()))).toBe(81);
  });

  it("is in every open board when they were sent to one that is decided, and in none that is not", () => {
    const state = utttState({
      turn: 1,
      last: { seat: 0, board: 0, cell: 4 },
      cells: marks({ 0: { 4: 0 }, 4: wonBoard(0) }),
    });
    const html = render(GRACE, gameOn(state));

    // Eight open boards: board 5 is won, and the one mark in board 1 leaves it eight cells.
    expect(pressable(html)).toBe(8 * 9 - 1);
  });

  it("is not on the other player's turn, but the board they must play in shows", () => {
    const html = render(ADA, gameOn());

    expect(pressable(html)).toBe(0);
    expect(count(html, "ttt-board-target")).toBe(1);
    expect(count(html, "ttt-board-yours")).toBe(0);
  });

  it("is not for someone who only watches", () => {
    expect(pressable(render(STRANGER, gameOn()))).toBe(0);
  });

  it("is not while a mark is on its way to the server", () => {
    expect(pressable(render(GRACE, gameOn_({ busy: true })))).toBe(0);
  });

  it("is not while the connection is down", () => {
    expect(pressable(render(GRACE, gameOn_({ connection: "reconnecting" })))).toBe(0);
  });

  it("is not once the game is over", () => {
    expect(pressable(render(ADA, gameOn(finished(0))))).toBe(0);
  });

  it("is not in a review, which shows the past", () => {
    const review = { gameId: GAME_ID, load: "ready" as const, error: null, frames: [asUtttFrame(1, utttState()), asUtttFrame(2, sentToCentre)], through: 2, at: 0 };

    expect(pressable(render(GRACE, gameOn(), { review }))).toBe(0);
  });
});

describe("what a player can do besides playing", () => {
  it("can give up, on either turn, in a game that is on", () => {
    expect(render(ADA, gameOn())).toContain("Forfeit");
    expect(render(GRACE, gameOn())).toContain("Forfeit");
    expect(render(ADA, viewOf())).toContain("Forfeit");
  });

  it("can not give up when watching, or when the game is over", () => {
    expect(render(STRANGER, gameOn())).not.toContain("Forfeit");
    expect(render(ADA, gameOn(finished(0)))).not.toContain("Forfeit");
  });

  it("can not give up while a request is on its way", () => {
    const html = render(ADA, gameOn_({ busy: true }));

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Forfeit<\/button>/);
  });

  it("can review the moves once there is one", () => {
    expect(render(ADA, gameOn())).toContain("Review moves");
    expect(render(ADA, viewOf())).not.toContain("Review moves");
  });

  it("is offered auto-play, which shows whether it is on", () => {
    expect(render(ADA, gameOn())).toContain("Auto-play");
    expect(render(ADA, gameOn())).toContain('aria-pressed="false"');
    expect(render(ADA, gameOn_({ auto: true }))).toContain('aria-pressed="true"');
  });

  it("is not offered auto-play when it is a development aid left out, or when watching", () => {
    expect(render(ADA, gameOn(), { showAutoplay: false })).not.toContain("Auto-play");
    expect(render(STRANGER, gameOn())).not.toContain("Auto-play");
  });

  it("has no dice, no undo and no selection: a mark is final", () => {
    const html = render(GRACE, gameOn());

    expect(html).not.toContain("Roll dice");
    expect(html).not.toContain("Undo");
  });
});

describe("a game that is over", () => {
  it("says who won, in a block of its own that replaces the status", () => {
    const html = render(ADA, gameOn(finished(0)));

    expect(html).toContain('aria-label="Result"');
    expect(html).toContain("You won");
    expect(html).toContain("Three boards in a row");
    expect(html).not.toContain('aria-label="Turn"');
  });

  it("tells the loser who won", () => {
    const html = render(GRACE, gameOn(finished(0)));

    expect(html).toContain("Ada won");
    expect(html).toContain("Game over");
  });

  it("says that it is a draw", () => {
    const html = render(ADA, gameOn(finished(null)));

    expect(html).toContain("Draw");
    expect(html).toContain("No one got three boards in a row");
  });

  it("says who gave up", () => {
    expect(render(ADA, gameOn(finished(0, true)))).toContain("Grace forfeited");
    expect(render(GRACE, gameOn(finished(0, true)))).toContain("You forfeited");
  });

  it("tints the three boards that won", () => {
    expect(count(render(ADA, gameOn(finished(0))), "ttt-board-line")).toBe(3);
  });

  it("tints no boards when the game was given up, or is a draw", () => {
    for (const state of [finished(0, true), finished(null)]) {
      expect(count(render(ADA, gameOn(state)), "ttt-board-line")).toBe(0);
    }
  });

  it("offers a rematch to a player, and only the way home to someone who watches", () => {
    const player = render(ADA, gameOn(finished(0)));
    const watcher = render(STRANGER, gameOn(finished(0)));

    expect(player).toContain("Rematch");
    expect(watcher).not.toContain("Rematch");
    expect(watcher).toContain("All games");
  });

  it("follows the rematch: asked, answered, and started", () => {
    const withRematch = (rematch: NonNullable<ReturnType<typeof utttSnapshotOf>["rematch"]>, userId: string) =>
      render(userId, viewOf({ snapshot: utttSnapshotOf({ state: finished(0), rematch }) }));

    expect(withRematch({ type: "offered", by: 0 }, ADA)).toContain("Waiting for Grace to accept the rematch…");
    expect(withRematch({ type: "offered", by: 0 }, GRACE)).toContain("Ada wants a rematch.");
    expect(withRematch({ type: "offered", by: 0 }, GRACE)).toContain("Accept");
    expect(withRematch({ type: "accepted", gameId: "game-2" }, ADA)).toContain("Go to the rematch");
  });

  it("shows why the rematch did not go through", () => {
    const html = render(ADA, gameOn(finished(0)), {
      rematchRequest: { gameId: GAME_ID, answer: "ask", state: "failed", error: "The game is not over yet." },
    });

    expect(html).toContain("The game is not over yet.");
  });
});

describe("the review", () => {
  const frames = [
    asUtttFrame(1, utttState()),
    asUtttFrame(2, sentToCentre),
    asUtttFrame(3, backToStart),
  ];
  const reviewOf = (overrides: Partial<NonNullable<GameScreenProps["review"]>> = {}) => ({
    gameId: GAME_ID,
    load: "ready" as const,
    error: null,
    frames,
    through: 3,
    at: null,
    ...overrides,
  });
  const panel = (html: string) => html.slice(html.indexOf('aria-label="Review"'));

  it("replaces the status for a player of a game that is on, with a way back", () => {
    const html = render(ADA, gameOn(backToStart), { review: reviewOf() });

    expect(html).toContain('aria-label="Review"');
    expect(html).not.toContain('aria-label="Turn"');
    expect(panel(html)).toContain("Close review");
    expect(panel(html)).toContain("In the game: Your turn. Play in the highlighted board.");
  });

  it("shows the position stepped to, not the game as it stands", () => {
    const html = render(ADA, gameOn(backToStart), { review: reviewOf({ at: 0 }) });

    // The start of the game has no marks; the game as it stands has two.
    expect(count(html, "ttt-mark-x")).toBe(1 /* the bar */);
    expect(count(html, "ttt-mark-o")).toBe(1 /* the bar */);
    expect(panel(html)).toContain('aria-valuetext="1 of 3"');
    expect(panel(html)).toContain("Start of the game");
  });

  it("says what led to the position on show, for a screen reader", () => {
    const html = render(ADA, gameOn(backToStart), { review: reviewOf({ at: 1 }) });

    expect(panel(html)).toContain("You marked cell 5 of board 1");
    expect(panel(html)).toContain('aria-valuetext="2 of 3"');
  });

  it("is always there, and can't be closed, for someone who watches", () => {
    const html = render(STRANGER, gameOn(backToStart), { review: reviewOf() });

    expect(panel(html)).not.toContain("Close review");
  });

  // A spectator's page is always in review, and so is that of anyone once the game is over: what
  // they see is a frame, and the board the next mark goes in has to show there too.
  describe("the board the next mark goes in", () => {
    const targets = (html: string) =>
      [...html.matchAll(/class="ttt-board [^"]*ttt-board-target[^"]*" role="group" aria-label="Board (\d)"/g)].map(
        (match) => Number(match[1]),
      );

    it("shows for a spectator, whose review is always on, on the newest position", () => {
      const html = render(STRANGER, gameOn(backToStart), { review: reviewOf() });

      // The last mark was in cell 1, so the next goes in board 1.
      expect(targets(html)).toEqual([1]);
      expect(pressable(html)).toBe(0);
      expect(count(html, "ttt-board-yours")).toBe(0);
    });

    it("shows for a spectator of a position stepped back to: the board that mark sent the player to", () => {
      const html = render(STRANGER, gameOn(backToStart), { review: reviewOf({ at: 1 }) });

      // After Ada's mark in cell 5, Grace was to play in board 5.
      expect(targets(html)).toEqual([5]);
    });

    it("shows at the start of the game as every board, where anything may be played", () => {
      const html = render(STRANGER, gameOn(backToStart), { review: reviewOf({ at: 0 }) });

      expect(targets(html)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it("shows for a player who steps back, though nothing in a review can be pressed", () => {
      const html = render(GRACE, gameOn(sentToCentre), { review: reviewOf({ at: 1 }) });

      expect(targets(html)).toEqual([5]);
      expect(pressable(html)).toBe(0);
      expect(count(html, "ttt-board-yours")).toBe(0);
    });

    it("is not shown for a game that is over", () => {
      const html = render(STRANGER, gameOn(finished(0)), { review: reviewOf({ frames: [asUtttFrame(9, finished(0))] }) });

      expect(targets(html)).toEqual([]);
    });
  });

  it("is above the result of a game that is over, which stays", () => {
    const html = render(ADA, gameOn(finished(0)), { review: reviewOf({ frames: [asUtttFrame(9, finished(0))] }) });

    expect(html.indexOf('aria-label="Review"')).toBeLessThan(html.indexOf('aria-label="Result"'));
    expect(panel(html)).not.toContain("In the game:");
  });

  it("is waiting for the positions while they load, and says so when it failed", () => {
    expect(panel(render(ADA, gameOn(), { review: reviewOf({ load: "loading", frames: [], through: -1 }) }))).toContain(
      "Loading the moves…",
    );
    const failed = render(ADA, gameOn(), { review: reviewOf({ load: "failed", error: "Something went wrong on the server. Try again.", frames: [], through: -1 }) });
    expect(panel(failed)).toContain("Something went wrong on the server. Try again.");
    expect(panel(failed)).toContain("Try again");
  });
});
