import { DbProvider } from "millpond/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewRow } from "../components/game/rows";
import { gameViews, joinRequests, rematchRequests, reviews } from "../features/game";
import { asHexFrame } from "../features/game/review";
import { router } from "../features/router";
import { sessionState } from "../features/session";
import { soundSettings } from "../features/sound";
import { GAME_ID, hexSnapshotOf, hexState, snapshotOf, stones } from "../fixtures";
import { componentDb, sessionRow } from "../testing";
import { GameScreen, type GameViewRow, isHexView } from "./GameScreen";

// Rendering to a string shows the first moment, before the loading text has waited its second.
// This one says it at once, which shows whether the page is waiting (see components/immediateLoading.tsx).
vi.mock("../components/Loading", () => import("../components/immediateLoading"));

// What a page shows is a function of what is in the db, so these put the rows in and render it to
// a string. The parts every game has (the invite, joining, the rematch, the review's controls) are
// covered by the other games' screens; these are about what is Hex's own.

const ADA = "user-a"; // seat 0, plays Red
const GRACE = "user-b"; // seat 1, plays Blue
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
    snapshot: hexSnapshotOf(),
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

/** The page as `userId` sees it, with `view` its game's row. */
function render(userId: string | null, view: GameViewRow | undefined, extra: { review?: ReviewRow } = {}) {
  const { db, put } = componentDb(
    { gameViews, joinRequests, rematchRequests, reviews, sessionState, soundSettings },
    { router },
  );
  dbs.push(db);
  put(sessionState, sessionRow(userId));
  if (view) put(gameViews, view);
  if (extra.review) put(reviews, extra.review);
  return renderToString(
    <DbProvider db={db}>
      <GameScreen gameId={GAME_ID} inviteUrl={URL} showAutoplay={true} />
    </DbProvider>,
  );
}

const count = (html: string, text: string) => html.split(text).length - 1;
const pressable = (html: string) => count(html, 'class="hex-open"');
const swapButton = ">Swap</button>";

/** Ada (Red) has opened on f6, and Grace (Blue) may swap. */
const opened = hexState({
  cells: stones({ f6: 0 }),
  turn: 1,
  last: { seat: 0, column: 5, row: 5, swap: false },
  canSwap: true,
});
const gameOn = (state = opened) => viewOf({ snapshot: hexSnapshotOf({ state }) });
const waiting = viewOf({ snapshot: hexSnapshotOf({ players: [ADA], playerNames: ["Ada"], state: null }) });

describe("the page", () => {
  it("has a title for a screen reader only, and the shape of the Hex board", () => {
    const html = render(ADA, gameOn());

    expect(html).toContain('<h1 class="visually-hidden">Hex</h1>');
    expect(html).toContain('class="page game-page game-page-hex"');
    expect(html).toContain('class="board-wrap hex-wrap"');
  });

  it("is told apart from another game by its kind", () => {
    expect(isHexView(gameOn())).toBe(true);
    expect(isHexView(waiting)).toBe(true);
    expect(isHexView({ ...gameOn(), snapshot: snapshotOf() } as never)).toBe(false);
  });

  it("shows nothing for a game of another kind", () => {
    expect(render(ADA, { ...gameOn(), snapshot: snapshotOf() } as never)).toBe("");
  });
});

describe("a game that is waiting for an opponent", () => {
  it("shows an empty board with nothing to press, and says who plays Red is not decided", () => {
    const html = render(ADA, waiting);

    expect(count(html, 'class="hex-cell"')).toBe(121);
    expect(pressable(html)).toBe(0);
    expect(html).toContain("Who plays Red and moves first is decided when the second player joins.");
    expect(count(html, "swatch-none")).toBe(2);
  });
});

describe("the player bars", () => {
  it("show each player's colour, the viewer's first, with its name for a screen reader", () => {
    const html = render(GRACE, gameOn());

    expect(html.indexOf("swatch-blue")).toBeLessThan(html.indexOf("swatch-red"));
    expect(html).toContain('<span class="visually-hidden">Blue</span>');
    expect(html).toContain('<span class="visually-hidden">Red</span>');
  });

  it("turn to the player Red for someone who only watches", () => {
    const html = render(STRANGER, viewOf({ snapshot: hexSnapshotOf({ state: hexState({ red: 1 }) }) }));

    expect(html.indexOf("Grace")).toBeLessThan(html.indexOf("Ada"));
  });

  it("mark the player to move", () => {
    const html = render(ADA, gameOn());

    expect(count(html, "player-bar-active")).toBe(1);
    const active = html.split('class="player-bar player-bar-active"')[1]?.split("</div>")[0] ?? "";
    expect(active).toContain("Grace");
  });
});

describe("the swap", () => {
  it("is offered to Blue on Blue's first turn, beside the cells", () => {
    const html = render(GRACE, gameOn());

    expect(html).toContain(swapButton);
    expect(pressable(html)).toBe(120);
    expect(html).toContain("Your turn. Place a stone, or swap to make Red&#x27;s stone yours.");
  });

  it("is not offered to Red, to someone who watches, or while a move is on its way", () => {
    expect(render(ADA, gameOn())).not.toContain(swapButton);
    expect(render(STRANGER, gameOn())).not.toContain(swapButton);
    expect(render(GRACE, { ...gameOn(), busy: true })).not.toContain(swapButton);
  });

  it("is not offered once Blue has placed a stone instead", () => {
    const later = hexState({
      cells: stones({ f6: 0, a1: 1, b2: 0 }),
      turn: 1,
      last: { seat: 0, column: 1, row: 1, swap: false },
    });

    const html = render(GRACE, gameOn(later));

    expect(html).not.toContain(swapButton);
    expect(html).toContain("Your turn. Join the left and right edges.");
  });
});

describe("the cells", () => {
  it("can be pressed by the player to move, and by nobody else", () => {
    expect(pressable(render(GRACE, gameOn()))).toBe(120);
    expect(pressable(render(ADA, gameOn()))).toBe(0);
    expect(pressable(render(STRANGER, gameOn()))).toBe(0);
  });

  it("can't be pressed while the connection is down", () => {
    const html = render(GRACE, { ...gameOn(), connection: "reconnecting" });

    expect(pressable(html)).toBe(0);
    expect(html).toContain("Connection lost. Reconnecting…");
  });

  it("can't be pressed in a review, which shows the position picked", () => {
    const review: ReviewRow = {
      gameId: GAME_ID,
      load: "ready",
      error: null,
      frames: [asHexFrame(1, hexState()), asHexFrame(2, opened)],
      through: 2,
      at: 0,
    };

    const html = render(GRACE, gameOn(), { review });

    expect(pressable(html)).toBe(0);
    expect(count(html, "hex-stone-red")).toBe(0);
    expect(html).toContain("Start of the game");
  });
});

describe("the end of the game", () => {
  it("says who won by joining their edges", () => {
    const won = hexState({
      ...opened,
      turn: 0,
      phase: { type: "over", winner: 0, forfeited: false },
      chain: [{ column: 5, row: 5 }],
    });

    const html = render(ADA, gameOn(won));

    expect(html).toContain("You won");
    expect(html).toContain("Joined the top and bottom edges");
    expect(html).not.toContain(swapButton);
  });
});
