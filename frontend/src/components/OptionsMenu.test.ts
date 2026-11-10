import { describe, expect, it } from "vitest";
import { closesMenu } from "./OptionsMenu";

describe("closesMenu", () => {
  it("is Esc, when the menu is open", () => {
    expect(closesMenu({ key: "Escape", defaultPrevented: false }, true)).toBe(true);
  });

  it("leaves a menu that is shut alone", () => {
    expect(closesMenu({ key: "Escape", defaultPrevented: false }, false)).toBe(false);
  });

  it("is no other key", () => {
    for (const key of ["Enter", "Tab", "a", " ", "ArrowDown"]) {
      expect(closesMenu({ key, defaultPrevented: false }, true)).toBe(false);
    }
  });

  it("leaves an Esc that something inside has used, like the name field cancelling its edit", () => {
    expect(closesMenu({ key: "Escape", defaultPrevented: true }, true)).toBe(false);
  });
});
