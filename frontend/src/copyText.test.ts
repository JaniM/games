import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copyText";

// There is no DOM here, so the browser is a few stand-ins: just what `copyText` touches.

afterEach(() => {
  vi.unstubAllGlobals();
});

const LINK = "https://games.test/games/k7m2xq9dtw4p";

/** A page whose `execCommand("copy")` answers `outcome` (a thrown error, or whether it copied). */
function page(outcome: boolean | Error, secure: boolean, writeText?: (text: string) => Promise<void>) {
  const field = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };
  const execCommand = vi.fn(() => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const appendChild = vi.fn();
  vi.stubGlobal("window", { isSecureContext: secure });
  vi.stubGlobal("navigator", writeText ? { clipboard: { writeText } } : {});
  vi.stubGlobal("document", { createElement: () => field, body: { appendChild }, execCommand });
  return { field, execCommand, appendChild };
}

describe("copying text", () => {
  it("uses the clipboard where the browser has it, and nothing else", async () => {
    const writeText = vi.fn(async () => {});
    const { execCommand } = page(true, true, writeText);

    expect(await copyText(LINK)).toBe(true);

    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("copies a selection on a page that has no clipboard, as one opened by its address on a network does", async () => {
    // Not a secure page: the browser leaves `navigator.clipboard` out.
    const { field, execCommand, appendChild } = page(true, false);

    expect(await copyText(LINK)).toBe(true);

    expect(field.value).toBe(LINK);
    expect(appendChild).toHaveBeenCalledWith(field);
    // By range, because Safari on iOS does nothing for `select()` alone.
    expect(field.setSelectionRange).toHaveBeenCalledWith(0, LINK.length);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(field.remove).toHaveBeenCalled();
  });

  it("keeps the field read-only and 16px, so that a phone neither opens its keyboard nor zooms", async () => {
    const { field } = page(true, false);

    await copyText(LINK);

    expect(field.setAttribute).toHaveBeenCalledWith("readonly", "");
    expect(field.style.fontSize).toBe("16px");
  });

  it("falls back to the selection when the clipboard refuses", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    const { execCommand } = page(true, true, writeText);

    expect(await copyText(LINK)).toBe(true);

    expect(writeText).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("says no when the browser copies nothing, and leaves nothing in the page", async () => {
    const { field } = page(false, false);

    expect(await copyText(LINK)).toBe(false);

    expect(field.remove).toHaveBeenCalled();
  });

  it("says no when the browser throws, and leaves nothing in the page", async () => {
    const { field } = page(new Error("not allowed"), false);

    expect(await copyText(LINK)).toBe(false);

    expect(field.remove).toHaveBeenCalled();
  });
});
