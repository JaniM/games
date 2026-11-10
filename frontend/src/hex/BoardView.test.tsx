import { DbProvider } from "millpond/react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { GAME_ID, hexState, stones } from "../fixtures";
import { componentDb } from "../testing";
import { BoardView, OpenCell } from "./Board";

// The board is a function of its props, so it is rendered to a string. A click can't be made
// without a DOM, so the tree it returns is searched for the cells that can be pressed, and what
// each of them plays is read from its props.

type Props = Parameters<typeof BoardView>[0];

// A cell that can be pressed calls the game's op, so it needs a db. Nothing is pressed here.
const { db } = componentDb({});
afterAll(() => db.dispose());

const render = (props: Partial<Props> = {}) =>
  renderToStaticMarkup(
    <DbProvider db={db}>
      <BoardView gameId={GAME_ID} state={hexState()} interactive={false} placed={null} {...props} />
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

const opened = hexState({
  cells: stones({ f6: 0 }),
  turn: 1,
  last: { seat: 0, column: 5, row: 5, swap: false },
  canSwap: true,
});

describe("the board", () => {
  it("is 121 cells inside the four parts of the edges, two of each colour", () => {
    const html = render();

    expect(count(html, 'class="hex-cell"')).toBe(121);
    expect(count(html, "hex-edge-red")).toBe(2);
    expect(count(html, "hex-edge-blue")).toBe(2);
    expect(html).toContain('aria-label="Hex board"');
  });

  it("is drawn empty before the game starts, with nothing to press", () => {
    const html = render({ state: null, interactive: true });

    expect(count(html, 'role="button"')).toBe(0);
    expect(count(html, "hex-stone")).toBe(0);
    expect(count(html, 'class="hex-cell"')).toBe(121);
  });

  it("puts a stone of each seat's colour where it played, named for a screen reader", () => {
    const state = hexState({ red: 1, cells: stones({ f6: 1, a1: 0 }) });

    const html = render({ state });

    expect(count(html, "hex-stone-red")).toBe(1);
    expect(count(html, "hex-stone-blue")).toBe(1);
    expect(html).toContain("<title>f6, Red</title>");
    expect(html).toContain("<title>a1, Blue</title>");
  });

  it("puts a dot on the stone the last move placed", () => {
    expect(count(render({ state: opened }), "hex-last")).toBe(1);
    expect(count(render(), "hex-last")).toBe(0);
  });

  it("sets down the stone that was just placed", () => {
    const html = render({ state: opened, placed: opened.last });

    expect(count(html, "hex-stone-fresh")).toBe(1);
  });

  it("makes every empty cell a button on the player's turn, with the mover's colour to show", () => {
    const html = render({ state: opened, interactive: true });

    expect(count(html, 'role="button"')).toBe(120);
    expect(html).toContain('aria-label="a1, empty"');
    expect(html).not.toContain('aria-label="f6, empty"');
    // Blue is to move.
    expect(count(html, "hex-ghost hex-stone-blue")).toBe(120);
  });

  it("presses a cell into a stone on that cell", () => {
    const tree = BoardView({ gameId: GAME_ID, state: opened, interactive: true, placed: null });
    const cells = find(tree, (element) => element.type === OpenCell);

    expect(cells).toHaveLength(120);
    expect(cells[0]?.props).toMatchObject({ column: 0, row: 0, colour: "blue", label: "a1, empty" });
  });

  it("makes nothing a button when it is not the player's turn, or in a review", () => {
    expect(count(render({ state: opened, interactive: false }), 'role="button"')).toBe(0);
  });

  it("shows the winning chain: the stones that are not part of it step back", () => {
    const won = hexState({
      cells: stones({ f1: 0, f2: 0, a5: 1 }),
      phase: { type: "over", winner: 0, forfeited: false },
      chain: [
        { column: 5, row: 0 },
        { column: 5, row: 1 },
      ],
    });

    const html = render({ state: won });

    expect(count(html, "hex-stone-faded")).toBe(1);
    expect(count(html, 'class="hex-stone hex-stone-red"')).toBe(2);
  });

  it("leaves every stone bright after a forfeit", () => {
    const given = hexState({ ...opened, phase: { type: "over", winner: 0, forfeited: true } });

    expect(count(render({ state: given }), "hex-stone-faded")).toBe(0);
  });
});
