import { DbProvider } from "millpond/react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { GAME_ID, marks, utttState, wonBoard } from "../fixtures";
import { componentDb } from "../testing";
import { BoardView, OpenCell } from "./Board";

// The board is a function of its props, so it is rendered to a string. A click can't be made
// without a DOM, so the tree it returns is searched for the cells that can be pressed, and what
// each of them plays is read from its props.

type Props = Parameters<typeof BoardView>[0];

// A cell that can be pressed calls the game's op, so it needs a db. Nothing is pressed here: an empty one does.
const { db } = componentDb({});
afterAll(() => db.dispose());

const render = (props: Partial<Props> = {}) =>
  renderToStaticMarkup(
    <DbProvider db={db}>
      <BoardView gameId={GAME_ID} state={utttState()} interactive={false} placed={null} {...props} />
    </DbProvider>,
  );

/** Every element in a tree of elements that `matches`, in order. */
function find(node: ReactNode, matches: (element: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((child) => find(child, matches));
  if (node === null || typeof node !== "object") return [];
  const element = node as ReactElement<Record<string, unknown>>;
  const here = matches(element) ? [element] : [];
  return [...here, ...find(element.props.children as ReactNode, matches)];
}

const count = (html: string, text: string) => html.split(text).length - 1;

describe("the board", () => {
  it("is nine boards of nine cells", () => {
    const html = render();

    expect(count(html, 'class="ttt-board ')).toBe(9);
    expect(count(html, 'class="ttt-cell')).toBe(81);
    expect(html).toContain('aria-label="Ultimate tic-tac-toe board"');
  });

  it("is drawn empty before the game starts, with nothing to press", () => {
    const html = render({ state: null, interactive: true });

    expect(count(html, "<button")).toBe(0);
    expect(count(html, "ttt-mark")).toBe(0);
    expect(count(html, 'class="ttt-board ')).toBe(9);
    expect(html).toContain('aria-label="Board 5"');
  });

  it("puts an X where the seat that plays X marked, and an O for the other", () => {
    const cells = marks({ 0: { 0: 0, 1: 1 } });

    const html = render({ state: utttState({ x: 0, cells }) });
    expect(count(html, "ttt-mark-x")).toBe(1);
    expect(count(html, "ttt-mark-o")).toBe(1);

    const swapped = render({ state: utttState({ x: 1, cells }) });
    expect(swapped).toContain('aria-label="cell 1 of board 1, O"');
    expect(swapped).toContain('aria-label="cell 2 of board 1, X"');
  });

  it("labels each marked cell for a screen reader, and leaves the empty ones out of the way", () => {
    const html = render({ state: utttState({ cells: marks({ 4: { 4: 0 } }) }) });

    expect(html).toContain('role="img" aria-label="cell 5 of board 5, X"');
    expect(count(html, 'class="ttt-cell" aria-hidden="true"')).toBe(80);
  });
});

describe("where the next mark goes", () => {
  const sent = utttState({ turn: 1, last: { seat: 0, board: 0, cell: 4 }, playable: [4], cells: marks({ 0: { 4: 0 } }) });

  it("marks the board in faintly, for everyone", () => {
    const html = render({ state: sent });

    expect(count(html, "ttt-board-target")).toBe(1);
    expect(count(html, "ttt-board-yours")).toBe(0);
    expect(html).toContain('class="ttt-board ttt-board-open ttt-board-target"');
  });

  it("marks it in the accent for the player whose turn it is", () => {
    const html = render({ state: sent, interactive: true });

    expect(count(html, "ttt-board-yours")).toBe(1);
  });

  it("marks every board it may go in, after being sent to one that is decided", () => {
    const html = render({ state: utttState(), interactive: true });

    expect(count(html, "ttt-board-target")).toBe(9);
  });

  it("leaves closed boards out, and a game that is over marks none", () => {
    const decided = utttState({ cells: marks({ 2: wonBoard(0) }), playable: [0, 1, 3] });
    expect(count(render({ state: decided }), "ttt-board-target")).toBe(3);

    const finished = utttState({ phase: { type: "over", winner: 0, forfeited: false }, playable: [4] });
    expect(count(render({ state: finished, interactive: true }), "ttt-board-target")).toBe(0);
  });
});

describe("pressing a cell", () => {
  const sent = utttState({ turn: 1, last: { seat: 0, board: 0, cell: 4 }, playable: [4], cells: marks({ 0: { 4: 0 }, 4: { 0: 1 } }) });
  const buttons = (props: Partial<Props>) =>
    find(
      BoardView({ gameId: GAME_ID, state: sent, interactive: true, placed: null, ...props }),
      (el) => el.type === OpenCell,
    );

  it("is possible only in the board the player was sent to, in the cells that are empty", () => {
    expect(buttons({})).toHaveLength(8);
    expect(count(render({ state: sent, interactive: true }), "<button")).toBe(8);
  });

  it("plays the board and the cell of the one pressed, in this game", () => {
    const cells = buttons({});

    expect(cells.every((button) => button.props.gameId === GAME_ID)).toBe(true);
    expect(cells.map((button) => `${button.props.board}.${button.props.cell}`)).toEqual(
      ["1", "2", "3", "4", "5", "6", "7", "8"].map((cell) => `4.${cell}`),
    );
  });

  it("is not possible when the player may not play now", () => {
    expect(buttons({ interactive: false })).toHaveLength(0);
  });

  it("is possible in every open board when the player may play anywhere", () => {
    const anywhere = utttState({ cells: marks({ 4: { 4: 0 } }) });

    expect(buttons({ state: anywhere })).toHaveLength(80);
  });

  it("is not possible in a board that is decided", () => {
    const state = utttState({ cells: marks({ 0: wonBoard(0) }) });

    expect(buttons({ state })).toHaveLength(72);
  });

  it("names each button by its cell", () => {
    const labels = buttons({}).map((button) => button.props.label);

    // Cell 1 of board 5 holds seat 1's mark, so it is not a button.
    expect(labels[0]).toBe("cell 2 of board 5, empty");
    expect(labels.some((label) => String(label).includes(", O"))).toBe(false);
  });
});

describe("a board that is decided", () => {
  it("shows the mark of its winner over it, and steps its own marks back", () => {
    const state = utttState({ cells: marks({ 3: wonBoard(1) }) });
    const html = render({ state });

    expect(html).toContain("ttt-board-won");
    expect(count(html, "ttt-claim")).toBe(1);
    // Seat 1 plays O, and won the board.
    expect(html).toContain('aria-label="Board 4, won by O"');
    expect(html.slice(html.indexOf("ttt-claim"))).toContain("ttt-mark-o");
  });

  it("has no big mark when it is drawn", () => {
    const state = utttState({ cells: marks({ 6: { 0: 0, 1: 1, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 0, 8: 0 } }) });
    const html = render({ state });

    expect(html).toContain("ttt-board-drawn");
    expect(count(html, "ttt-claim")).toBe(0);
    expect(html).toContain('aria-label="Board 7, drawn"');
  });

  it("has no buttons, even for a player who may play anywhere", () => {
    const state = utttState({ cells: marks({ 3: wonBoard(1) }) });

    const board = find(
      BoardView({ gameId: GAME_ID, state, interactive: true, placed: null }),
      (el) => el.type === OpenCell,
    );
    const labels = board.map((button) => String(button.props.label));
    expect(labels.some((label) => label.includes("of board 4"))).toBe(false);
  });
});

describe("what just happened", () => {
  const state = utttState({ turn: 1, last: { seat: 0, board: 4, cell: 4 }, cells: marks({ 4: { 4: 0 } }), playable: [4] });

  it("marks the cell of the last mark", () => {
    const html = render({ state });

    expect(count(html, "ttt-cell-last")).toBe(1);
    expect(html).toContain('class="ttt-cell ttt-cell-last" role="img" aria-label="cell 5 of board 5, X"');
  });

  it("draws a mark that was just placed in, and no other", () => {
    const fresh = render({ state, placed: { seat: 0, board: 4, cell: 4 } });
    const still = render({ state });

    expect(count(fresh, "ttt-mark-fresh")).toBe(1);
    expect(count(still, "ttt-mark-fresh")).toBe(0);
  });

  it("draws the big mark of a board just won in as well", () => {
    const won = utttState({ last: { seat: 0, board: 0, cell: 2 }, cells: marks({ 0: wonBoard(0) }) });
    const html = render({ state: won, placed: { seat: 0, board: 0, cell: 2 } });

    // The mark that won, and the claim it made.
    expect(count(html, "ttt-mark-fresh")).toBe(2);
    expect(html.slice(html.indexOf("ttt-claim"))).toContain("ttt-mark-fresh");
  });

  describe("the boards that won the game", () => {
    const finished = utttState({
      phase: { type: "over", winner: 0, forfeited: false },
      cells: marks({ 0: wonBoard(0), 4: wonBoard(0), 8: wonBoard(0) }),
      line: [0, 4, 8],
    });
    const tinted = (html: string) =>
      [...html.matchAll(/ttt-board-line[^"]*" role="group" aria-label="Board (\d)/g)].map((match) => Number(match[1]));

    it("are tinted, the three the server named", () => {
      expect(tinted(render({ state: finished }))).toEqual([1, 5, 9]);
    });

    it("are whichever the server named, and not others that the player also holds", () => {
      const state = utttState({
        phase: { type: "over", winner: 0, forfeited: false },
        // Seat 0 holds four boards, but the line is the top row.
        cells: marks({ 0: wonBoard(0), 1: wonBoard(0), 2: wonBoard(0), 8: wonBoard(0) }),
        line: [0, 1, 2],
      });

      expect(tinted(render({ state }))).toEqual([1, 2, 3]);
    });

    it("are not tinted for a draw, a forfeit or a game that is on, which have no line", () => {
      const draw = utttState({ phase: { type: "over", winner: null, forfeited: false }, line: null });
      const forfeited = utttState({ phase: { type: "over", winner: 1, forfeited: true }, line: null });

      expect(tinted(render({ state: draw }))).toEqual([]);
      expect(tinted(render({ state: forfeited }))).toEqual([]);
      expect(tinted(render({ state: utttState() }))).toEqual([]);
    });

    it("have no frame and no line drawn on or across them, though the last mark has just been placed", () => {
      const html = render({ state: finished, placed: { seat: 0, board: 8, cell: 2 } });

      expect(count(html, "<line")).toBe(0);
      expect(count(html, "ttt-line")).toBe(0);
      // The only frame on the board is the one on the board to play in, and a game that is over has none.
      expect(count(html, "ttt-board-target")).toBe(0);
    });
  });
});
