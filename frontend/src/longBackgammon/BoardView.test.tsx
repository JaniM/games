import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { board, moving, startingState } from "../fixtures";
import type { LongBackgammonState, Seat } from "../features/game";
import { BoardView } from "./Board";
import type { Motion } from "./motion";

// The board is a drawing of its props, so the motion it is given can be checked in the markup.
// (Whether it looks right while it runs is for a browser: there is none here.)

const noop = () => {};

function draw(state: LongBackgammonState, motion: Motion | null, rolls = 0, viewer: Seat = 0) {
  return renderToString(
    <BoardView
      state={state}
      revision={7}
      viewer={viewer}
      selected={null}
      interactive={false}
      motion={motion}
      rolls={rolls}
      onSelect={noop}
      onMove={noop}
    />,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

const stepped = startingState({
  points: [board({ 1: 14, 7: 1 }), board({ 1: 15 })],
  ...moving([6, 3], [{ from: 7, die: 3 }], [{ from: 1, die: 6 }], [3]),
});
const step: Motion = {
  type: "move",
  seat: 0,
  from: { at: 1, count: 15 },
  to: { at: 7, count: 1 },
};

describe("a checker that moved", () => {
  it("flies from where it was to where it lands, over the board", () => {
    const html = draw(stepped, step);

    expect(count(html, 'class="flyer"')).toBe(1);
    // It starts from the top of the 15 on the head (top right, slot 4), and lands on slot 0 of
    // the point six columns to the left, across the bar: 6 * 48 + 28 across, 4 * 34 down.
    expect(html).toMatch(/class="flyer" style="--dx:316px;--dy:136px;/);
    // It is the last thing drawn, so nothing covers it.
    expect(html.lastIndexOf('class="flyer"')).toBeGreaterThan(html.lastIndexOf('class="tray"'));
  });

  it("hops in an arc: three layers, pushed towards the middle of the board", () => {
    const html = draw(stepped, step);

    expect(html).toMatch(/class="flyer"[^>]*><g class="flyer-lift"><g class="flyer-body"><circle/);
    // This trip is along the top row, so its hop bulges down (and a little back).
    const [, hopX, hopY] = /--hop-x:(-?\d+)px;--hop-y:(-?\d+)px/.exec(html) ?? [];
    expect(Number(hopY)).toBeGreaterThan(40);
    expect(Math.abs(Number(hopX))).toBeLessThan(Number(hopY));
  });

  it("is held back at its resting place until it lands", () => {
    const html = draw(stepped, step);

    expect(count(html, "checker-arriving")).toBe(1);
  });

  it("is drawn in its owner's colour", () => {
    // Ada (seat 0) is White; the opponent's step is Black's.
    expect(draw(stepped, step)).toMatch(/class="flyer-body"><circle class="checker checker-white"/);
    const black: Motion = { ...step, seat: 1 };
    expect(draw(stepped, black)).toMatch(/class="flyer-body"><circle class="checker checker-black"/);
  });

  it("leaves no flyer and holds nothing back when nothing moved", () => {
    const html = draw(stepped, null);

    expect(html).not.toContain("flyer");
    expect(html).not.toContain("checker-arriving");
  });

  it("flies into the tray when it bears off, and the slab waits for it", () => {
    const state = startingState({
      points: [board({ 22: 14 }), board({ 1: 15 })],
      off: [1, 0],
      ...moving([5, 6], [{ from: 22, die: 6 }], [{ from: 20, die: 5 }], [6]),
    });
    const html = draw(state, {
      type: "move",
      seat: 0,
      from: { at: 20, count: 1 },
      to: { at: "off", count: 1 },
    });

    expect(count(html, 'class="flyer"')).toBe(1);
    expect(html).toMatch(/<rect class="checker checker-white checker-arriving"/);
  });

  it("holds back the top checker of a tall stack too, and lands on it", () => {
    const crowded = startingState({
      points: [board({ 1: 8, 7: 7 }), board({ 1: 15 })],
      ...moving([6, 3], [], [{ from: 1, die: 6 }], [3]),
    });
    const html = draw(crowded, { ...step, to: { at: 7, count: 7 } });

    expect(count(html, 'class="flyer"')).toBe(1);
    expect(count(html, "checker-arriving")).toBe(1);
    // The held-back checker is the seventh, at the top of the stack (y = 185).
    expect(html).toMatch(/checker-arriving" cx="276" cy="185"/);
    // The top of a long stack is where the fifth of a short one is, so the flight from the
    // head's top checker (also y = 185) runs level.
    expect(html).toMatch(/class="flyer" style="--dx:316px;--dy:0px;/);
  });

  it("draws every checker of a long stack, not five of them", () => {
    const html = draw(startingState(), null); // fifteen on each head

    expect(count(html, '<circle class="checker ')).toBe(30);
    // The count is still on the top one, as a help for reading a squeezed stack.
    expect(html).toContain(">15<");
  });

});

// The marker that shows where the selected checker would land moves it there. Whether a press
// reaches it is for a browser, but what it covers is in the markup: a press on a checker only
// selects it, so on a full stack the marker has to cover the top checker, or nothing can land.
describe("the landing marker", () => {
  /** Seat 0 has picked the checker on point 1 and could play the 6 to point 7. */
  function pick(onSeven: number) {
    const state = startingState({
      points: [board({ 1: 8, 7: onSeven }), board({ 1: 15 })],
      ...moving([6, 3], [{ from: 1, die: 6 }]),
    });
    return renderToString(
      <BoardView
        state={state}
        revision={7}
        viewer={0}
        selected={1}
        interactive
        motion={null}
        rolls={0}
        onSelect={noop}
        onMove={noop}
      />,
    );
  }

  it("covers the whole top checker of a full stack", () => {
    const html = pick(7);

    // The top checker of seven is at y = 185, with a radius of 19 and a stroke on it.
    expect(html).toContain('<circle class="checker checker-white" cx="276" cy="185" r="19"');
    // The marker sits on it, drawn after it, and its catching area is wider than the checker.
    expect(html).toContain('<circle class="ghost-hit" cx="276" cy="185" r="21"');
    expect(html.indexOf('class="ghost-hit"')).toBeGreaterThan(
      html.indexOf('cx="276" cy="185" r="19"'),
    );
  });

  it("covers a stack of exactly five as well, where the marker also sits on the top one", () => {
    const html = pick(5);

    // The fifth checker and the marker are both at y = 185.
    expect(html).toContain('<circle class="checker checker-white" cx="276" cy="185" r="19"');
    expect(html).toContain('<circle class="ghost-hit" cx="276" cy="185" r="21"');
  });

  it("stays the size of its outline where there is room, so it takes nothing from the checkers", () => {
    // Two checkers; the marker is in the third place, at y = 117.
    expect(pick(2)).toContain('<circle class="ghost-hit" cx="276" cy="117" r="17"');
  });
});

/** The board as the mover sees it, with the checker on point `selected` picked up. */
function drawPicked(state: LongBackgammonState, selected: number | null) {
  return renderToString(
    <BoardView
      state={state}
      revision={7}
      viewer={0}
      selected={selected}
      interactive
      motion={null}
      rolls={0}
      onSelect={noop}
      onMove={noop}
    />,
  );
}

describe("the markers of a combined move", () => {
  // A 3-6 with the checker on 1 picked. Playing both dice with it is 1 to 4 to 10 or 1 to 7 to 10.
  const state = startingState({
    points: [board({ 1: 14, 20: 1 }), board({ 1: 15 })],
    ...moving(
      [3, 6],
      [
        { from: 1, die: 3 },
        { from: 1, die: 6 },
      ],
      [],
      [3, 6],
      [
        [
          { from: 1, die: 3 },
          { from: 4, die: 6 },
        ],
        [
          { from: 1, die: 6 },
          { from: 7, die: 3 },
        ],
      ],
    ),
  });

  it("show the single dice and the combined move at once", () => {
    const html = drawPicked(state, 1);

    expect(count(html, 'class="ghost"')).toBe(2);
    expect(count(html, 'class="ghost ghost-combo"')).toBe(1);
  });

  it("say the dice added up, and spell them out in a tooltip", () => {
    const html = drawPicked(state, 1);

    const combo = html.slice(html.indexOf('class="ghost ghost-combo"'));
    expect(combo).toContain("<title>3 + 6 = 9</title>");
    expect(combo.slice(0, combo.indexOf("</g>"))).toContain(">9</text>");
    // A single die's marker has no tooltip.
    expect(html.slice(html.indexOf('class="ghost"'), html.indexOf('class="ghost ghost-combo"'))).not.toContain(
      "<title>",
    );
  });

  it("make the point a button that names both dice", () => {
    // Point 10 of the mover is point 15 on the board (25 - 10, as White).
    expect(drawPicked(state, 1)).toContain('aria-label="Move to point 15 with the 3 and the 6"');
  });

  it("show nothing for a checker that has no combined move", () => {
    const html = drawPicked(startingState({ ...state, combos: [] }), 1);

    expect(count(html, "ghost-combo")).toBe(0);
    expect(count(html, 'class="ghost"')).toBe(2);
  });
});

describe("the tray as a bear-off button", () => {
  // Everything is home. The checker on 20 can be borne off with the 5.
  const home = startingState({
    points: [board({ 20: 1, 22: 14 }), board({ 1: 15 })],
    ...moving([5, 2], [{ from: 20, die: 5 }, { from: 22, die: 2 }]),
  });

  it("covers the whole tray, not only the label, when the picked checker can be borne off", () => {
    const html = drawPicked(home, 20);

    // The viewer's tray is bottom right: x = 628, y = 492 - 170, 80 by 170.
    expect(html).toMatch(/<g class="bear-off"[^>]*aria-label="Bear off"/);
    expect(html).toContain('<rect class="bear-off-hit" x="628" y="322" width="80" height="170"');
    // The hit area is inside the one button, with the label.
    const button = html.slice(html.indexOf('class="bear-off"'));
    expect(button.indexOf("bear-off-hit")).toBeLessThan(button.indexOf("bear-off-label"));
    expect(count(html, 'aria-label="Bear off"')).toBe(1);
  });

  it("lights the tray up, to show where to press", () => {
    expect(count(drawPicked(home, 20), 'class="tray-box tray-box-active"')).toBe(1);
  });

  it("is only the tray the picked checker can go to, and only while one is picked", () => {
    for (const html of [drawPicked(home, null), drawPicked(home, 22)]) {
      // The checker on 22 cannot be borne off with a 5 or a 2 here, and none is picked at all.
      expect(html).not.toContain("bear-off");
      expect(html).not.toContain("tray-box-active");
    }
  });
});

describe("the dice", () => {
  it("lie still on a board that opened mid-game", () => {
    const html = draw(stepped, null, 0);

    expect(html).toContain('class="dice"');
    expect(html).not.toContain("dice-rolling");
  });

  it("tumble in after a roll", () => {
    const rolled = startingState(moving([6, 3], [{ from: 1, die: 6 }]));
    const html = draw(rolled, { type: "roll" }, 1);

    expect(html).toContain('class="dice dice-rolling"');
    expect(count(html, 'class="die-roll"')).toBe(2);
  });

  it("keep their tumble class while later steps are played, so a repaint doesn't restart it", () => {
    // Only a new roll gives the group a new key, and that is what starts the tumble again.
    expect(draw(stepped, step, 1)).toContain("dice-rolling");
  });

  it("show four dice for a double", () => {
    const double = startingState(moving([4, 4], [{ from: 1, die: 4 }]));

    expect(count(draw(double, { type: "roll" }, 1), 'class="die-roll"')).toBe(4);
  });
});
