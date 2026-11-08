import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "./randomId";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe("randomId", () => {
  it("is a version 4 uuid", () => {
    expect(randomId()).toMatch(V4);
  });

  it("still is on an insecure page, where crypto.randomUUID does not exist", () => {
    // What a phone gets from the dev server over plain http: `getRandomValues` and nothing else.
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    expect(typeof crypto.randomUUID).toBe("undefined");

    const ids = Array.from({ length: 50 }, randomId);

    for (const id of ids) expect(id).toMatch(V4);
    expect(new Set(ids).size).toBe(50);
  });
});
