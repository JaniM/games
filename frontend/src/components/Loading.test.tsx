import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Loading } from "./Loading";

// There is no DOM here, so a render is only the first moment: no time has gone by.
// (The text turning up after a second is not covered: that needs a DOM and timers.)

describe("the loading text", () => {
  it("is not there when the wait has only just begun", () => {
    expect(renderToString(<Loading />)).toBe("");
  });
});
