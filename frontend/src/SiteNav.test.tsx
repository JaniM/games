import { createDb } from "millpond";
import { DbProvider } from "millpond/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { type NavPage, SiteNav } from "./SiteNav";
import { router } from "./features/router";

// What the nav shows is a function of its props, so these render it to a string.

const dbs: { dispose(): void }[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
});

function render(page: NavPage) {
  const db = createDb({ features: { router } });
  dbs.push(db);
  return renderToString(
    <DbProvider db={db}>
      <SiteNav page={page} />
    </DbProvider>,
  );
}

/** The links of the nav as (address, text, whether it is marked as the current page), whatever order the attributes are in. */
function links(html: string) {
  return [...html.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)].map(([, attributes = "", text]) => [
    /href="([^"]*)"/.exec(attributes)?.[1],
    text,
    attributes.includes('aria-current="page"'),
  ]);
}

describe("the site nav", () => {
  it("links to home and, as Watch, to the public list, in that order", () => {
    const html = render("other");

    expect(html).toContain('<nav class="site-nav" aria-label="Site">');
    expect(links(html)).toEqual([
      ["/", "Home", false],
      ["/games", "Watch", false],
    ]);
  });

  it("marks home as the page you are on", () => {
    expect(links(render("home"))).toEqual([
      ["/", "Home", true],
      ["/games", "Watch", false],
    ]);
  });

  it("marks the public list as the page you are on", () => {
    expect(links(render("games"))).toEqual([
      ["/", "Home", false],
      ["/games", "Watch", true],
    ]);
  });

  it("marks neither on another page", () => {
    expect(render("other")).not.toContain("aria-current");
  });
});
