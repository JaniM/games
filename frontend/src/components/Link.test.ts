import { describe, expect, it } from "vitest";
import { isPlainLeftClick } from "./Link";

const click = (over: Partial<Parameters<typeof isPlainLeftClick>[0]> = {}) => ({
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  ...over,
});

describe("isPlainLeftClick", () => {
  it("is a plain click with the main button", () => {
    expect(isPlainLeftClick(click())).toBe(true);
  });

  it.each([
    ["a middle click", { button: 1 }],
    ["a right click", { button: 2 }],
    ["Cmd-click", { metaKey: true }],
    ["Ctrl-click", { ctrlKey: true }],
    ["Shift-click", { shiftKey: true }],
    ["Alt-click", { altKey: true }],
    ["a click someone handled", { defaultPrevented: true }],
  ])("leaves %s to the browser", (_, over) => {
    expect(isPlainLeftClick(click(over))).toBe(false);
  });
});
