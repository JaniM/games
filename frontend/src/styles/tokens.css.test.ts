import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The dark colours are written twice in `tokens.css`: for a device that is set to dark, and for a
// visitor who picked dark. They would drift if one were changed alone, so this compares them.

// Without the comments, which hold semicolons and braces of their own.
const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The declarations of every block with exactly this selector, each block a list of "name: value". */
function blocks(selector: string): string[][] {
  const open = new RegExp(`${escaped(selector)}\\s*\\{([^}]*)\\}`, "g");
  return [...css.matchAll(open)].map((match) =>
    (match[1] ?? "")
      .split(";")
      .map((declaration) => declaration.trim().replace(/\s+/g, " "))
      .filter((declaration) => declaration !== ""),
  );
}

/** The first block with this selector. */
function block(selector: string): string[] {
  const [first] = blocks(selector);
  if (!first) throw new Error(`no block for ${selector}`);
  return first;
}

const DEVICE_DARK = ':root:not([data-theme="light"])';
const PICKED_DARK = ':root[data-theme="dark"]';

const names = (declarations: string[]) => declarations.map((declaration) => declaration.split(":")[0]).sort();

describe("the dark colours in tokens.css", () => {
  it("are the same for a device that is set to dark and for a visitor who picked dark", () => {
    const device = blocks(DEVICE_DARK);
    const picked = blocks(PICKED_DARK).filter((declarations) => declarations.some((declaration) => declaration.startsWith("--")));

    // The colours of the page, the wood of the long backgammon board, and the wood of the Hex board.
    expect(device).toHaveLength(3);
    expect(picked).toHaveLength(3);
    expect(picked).toEqual(device);
  });

  it("are all of the page's colours that change", () => {
    const page = block(DEVICE_DARK);
    const light = block(":root");

    // Every colour of the dark page is one the light page has, so that none is dark only.
    for (const name of names(page)) expect(names(light), name).toContain(name);
    expect(names(page)).toEqual(
      ["--accent", "--bg", "--card", "--fg", "--line", "--mark-o", "--muted", "--on-accent", "--rule"].sort(),
    );
  });

  it("make the browser draw its own parts in the colours picked", () => {
    expect(blocks(':root[data-theme="light"]')).toEqual([["color-scheme: light"]]);
    expect(blocks(PICKED_DARK)[0]).toEqual(["color-scheme: dark"]);
  });
});
