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
    expect(html).toContain("the game’s state");
  });

  it("says what an account keeps on the server: a hash of the password and of each session's token", () => {
    const html = privacy();

    expect(html).toContain("your username");
    expect(html).toContain("your password as a hash that can’t be turned back into the password");
    expect(html).toContain("a hash of its token, when it was made and when it was last used");
    expect(html).toContain("your access token, if you are a guest");
    // Not an email: an account has none.
    expect(html).toContain("and no email address");
    expect(html).toContain("a lost password can’t be reset");
  });

  it("says how long a session lasts", () => {
    const html = privacy();

    expect(html).toContain("has not been used for 30 days stops working");
    expect(html).toContain("signing out ends it at once");
  });

  it("says what the browser keeps, under the keys the code uses, including the username of an account", () => {
    const html = privacy();

    expect(html).toContain("<code>games.session</code>");
    expect(html).toContain("<code>games.volume</code>");
    expect(html).toContain("and your username if you have an account");
  });

  it("says that the username is the name in games, that nobody else can have it, and that guests are marked", () => {
    const html = privacy();

    expect(html).toContain("Your username is your name in games.");
    expect(html).toContain("Nobody else can have it, whatever its case, and you can’t change it later.");
    expect(html).toContain("It replaces the display name you had as a guest.");
    expect(html).toContain("other players see it with “(guest)” after it");
    expect(html).toContain("If you have an account, your username is shown as your name.");
    expect(html).not.toContain("Your username is not shown to anyone");
  });

  it("says that only a guest's name can be changed", () => {
    const html = privacy();

    expect(html).toContain("If you are a guest, you can change your display name at any time");
    expect(html).toContain("The name of an account is its username, which can’t be changed.");
  });

  it("says who can see a game, including anyone who only has the link", () => {
    const html = privacy();

    expect(html).toContain("anyone who has the link to a game");
    expect(html).toContain("display name");
  });

  it("says that a game can be public, who sees it then, and what that choice covers", () => {
    const html = privacy();

    expect(html).toContain("Anyone, with no link and no account,");
    expect(html).toContain("can see the public games at");
    expect(html).toContain('<a href="/games">/games</a>');
    expect(html).toContain("left “Public game” ticked in the dialog for a new game");
    expect(html).toContain("the site remembers the choice in that browser");
    expect(html).toContain("anyone can open it and watch every move");
    expect(html).toContain("A rematch of a public game is public.");
    expect(html).toContain("Games still waiting for an opponent, and games made before the list existed, are not in it.");
    expect(html).toContain("can’t be changed afterwards");
  });

  it("says the site keeps whether a game is public, and the browser whether new games are", () => {
    const html = privacy();

    expect(html).toContain("whether it is public");
    expect(html).toContain("<code>games.public</code>");
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

  it("says that a user can delete themselves, and what that does to their games", () => {
    const html = privacy();

    expect(html).toContain("You can delete your user");
    expect(html).toContain("from the same menu, whether you have an account or are a guest");
    expect(html).toContain("Your username (your name), password hash, sessions and display name are deleted.");
    expect(html).toContain("Games you are playing against another person are forfeited, so they win");
    expect(html).toContain("as do your finished games against other people");
    expect(html).toContain("Games against the bot, and games nobody else has joined, are deleted.");
    expect(html).toContain("It can’t be undone.");
    expect(html).not.toContain("no button on the site to delete them yourself");
  });

  it("points to the account menu for the display name and for signing out", () => {
    const html = privacy();

    expect(html).toContain("from the account menu in the top right corner");
    expect(html).toContain("You can sign out from the same menu");
    expect(html).toContain("<strong>You can delete your user</strong> from the same menu");
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
    expect(html).toContain("or until Acme Ltd deletes them");
    expect(html).not.toContain("Seequ");
  });

  it("sends a request to delete games to the operator's address, with the links to them", () => {
    const html = privacy({ operator: { name: "Acme Ltd", email: "help@acme.test" } });

    expect(html).toContain("To have your games deleted, write to");
    expect(html).toContain('href="mailto:help@acme.test"');
    expect(html).toContain("with the links to them");
    // Three times, each time as a link and as text: where the page says who runs the site, where
    // it says how to take a public game out of the list, and where it says how to ask for deletion.
    expect(html.match(/help@acme\.test/g)).toHaveLength(6);
  });

  it("says that a game can only be opened with its link", () => {
    expect(privacy()).toContain("A game can only be opened by someone who has its link.");
  });

  it("links back to the games", () => {
    expect(privacy()).toContain('href="/"');
  });
});

describe("the privacy link on the front page", () => {
  it("links to the privacy policy", () => {
    const html = render(<SiteFooter />);

    expect(html).toContain("<footer");
    expect(html).toContain('href="/privacy"');
    expect(html).toContain(">Privacy<");
  });
});
