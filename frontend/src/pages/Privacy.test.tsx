import { createDb } from "millpond";
import { DbProvider } from "millpond/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SiteFooter } from "../SiteFooter";
import { router } from "../features/router";
import { Privacy, type PrivacyProps } from "./Privacy";

// What the page says is a function of its props, so these render it to a string.

const dbs: { dispose(): void }[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
});

function render(element: React.ReactNode) {
  const db = createDb({ features: { router } });
  dbs.push(db);
  return renderToString(<DbProvider db={db}>{element}</DbProvider>);
}

/** The page as text and tags. Server rendering marks where one piece of text ends and the next begins, which a reader doesn't see. */
const privacy = (props: PrivacyProps = {}) =>
  render(<Privacy {...props} />).replaceAll("<!-- -->", "");

describe("the privacy policy", () => {
  it("says what the server keeps about a person", () => {
    const html = privacy();

    expect(html).toContain("anonymous user");
    expect(html).toContain("access token");
    expect(html).toContain("display name");
    expect(html).toContain("every game you are in");
  });

  it("says what the browser keeps, under the keys the code uses", () => {
    const html = privacy();

    expect(html).toContain("<code>games.session</code>");
    expect(html).toContain("<code>games.volume</code>");
  });

  it("says who can see a game, including anyone who only has the link", () => {
    const html = privacy();

    expect(html).toContain("anyone who has the link to a game");
    expect(html).toContain("display name");
  });

  it("says that the host may keep access logs, with the IP address in them", () => {
    const html = privacy();

    expect(html).toContain("Whoever hosts the site may keep ordinary access logs");
    expect(html).toContain("the IP address it came from");
  });

  it("explains only what is collected: it has no section, or claim, about what is not", () => {
    const html = privacy();

    expect(html).not.toContain("does not collect");
    expect(html).not.toContain("No analytics");
    expect(html).not.toContain("no cookies");
    expect(html).not.toContain("does not record");
  });

  it("says that nothing is deleted on its own and there is no button for it", () => {
    expect(privacy()).toContain("no button on the site to delete them yourself");
  });

  it("names the company that runs the site and where to write to it", () => {
    const html = privacy();

    expect(html).toContain("<h2>Who runs the site</h2>");
    expect(html).toContain("Seequ Oy runs this site.");
    expect(html).toContain('<a href="mailto:support@seequ.dev">support@seequ.dev</a>');
  });

  it("names the operator wherever it says who keeps and can read the data", () => {
    const html = privacy({ operator: { name: "Acme Ltd", email: "help@acme.test" } });

    expect(html).toContain("Acme Ltd runs this site.");
    expect(html).toContain("Acme Ltd, which runs the site, can read everything the server keeps.");
    expect(html).toContain("kept until Acme Ltd deletes them");
    expect(html).not.toContain("Seequ");
  });

  it("sends a request to delete games to the operator's address, with the links to them", () => {
    const html = privacy({ operator: { name: "Acme Ltd", email: "help@acme.test" } });

    expect(html).toContain("To have your games deleted, write to");
    expect(html).toContain('href="mailto:help@acme.test"');
    expect(html).toContain("with the links to them");
    // Twice, each time as a link and as text: where the page says who runs the site, and where it says how to ask for deletion.
    expect(html.match(/help@acme\.test/g)).toHaveLength(4);
  });

  it("says that a game can only be opened with its link", () => {
    expect(privacy()).toContain("A game can only be opened by someone who has its link.");
  });

  it("links back to the games", () => {
    expect(privacy()).toContain('href="/"');
  });
});

describe("the foot of every page", () => {
  it("links to the privacy policy", () => {
    const html = render(<SiteFooter />);

    expect(html).toContain("<footer");
    expect(html).toContain('href="/privacy"');
    expect(html).toContain(">Privacy<");
  });
});
