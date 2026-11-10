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

const ACME = {
  name: "Acme Ltd",
  email: "help@acme.test",
  url: "https://games.acme.test/",
  address: ["1 High Street", "Leeds LS1 1AA", "England"],
};

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
    expect(html).toContain("<code>games.theme</code>");
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

  it("makes no promise about analytics, cookies or recording, which the site can't keep for whoever hosts it", () => {
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

  it("names the company that runs the site, where it is, and where to write to it", () => {
    const html = privacy();

    expect(html).toContain("This Privacy Notice for Seequ Oy (“we,” “us,” or “our”)");
    expect(html).toContain("Visit our website at https://games.seequ.dev/ or any website of ours");
    expect(html).toContain('<a href="mailto:support@seequ.dev">support@seequ.dev</a>');
  });

  it("gives the postal address, one line to each", () => {
    expect(privacy()).toContain("Seequ Oy<br/>PL 14<br/>Oulu 90571<br/>Finland");
  });

  it("names the operator wherever it says who can read the data", () => {
    const html = privacy({ operator: ACME });

    expect(html).toContain("Acme Ltd, which runs the site, can read everything the server keeps.");
  });

  it("takes everything it says about who runs the site from the operator", () => {
    const html = privacy({ operator: ACME });

    expect(html).toContain("This Privacy Notice for Acme Ltd");
    expect(html).toContain("Visit our website at https://games.acme.test/");
    expect(html).toContain("Acme Ltd<br/>1 High Street<br/>Leeds LS1 1AA<br/>England");
    expect(html).not.toMatch(/Seequ|seequ|Oulu/);
  });

  it("sends a request to delete games to the operator's address, with the links to them", () => {
    const html = privacy({ operator: ACME });

    expect(html).toContain("To have your games deleted, write to");
    expect(html).toContain('href="mailto:help@acme.test"');
    expect(html).toContain("with the links to them");
    expect(html).not.toContain("support@seequ.dev");
  });

  it("says when it was last updated", () => {
    expect(privacy()).toContain("Last updated November 10, 2026");
  });

  it("says that a game can only be opened with its link", () => {
    expect(privacy()).toContain("A game can only be opened by someone who has its link.");
  });

  it("says what a link to a game shows where it is pasted, and that the site that fetched it may keep it", () => {
    const html = privacy();

    expect(html).toContain("A chat or social site you paste a link to a game into");
    expect(html).toContain("a picture of the board as it stands");
    expect(html).toContain("what it keeps is out of our hands");
  });

  it("links back to the games", () => {
    expect(privacy()).toContain('href="/"');
  });
});

describe("the privacy policy's structure", () => {
  const sections = [
    "1. What information do we collect?",
    "2. How do we process your information?",
    "3. What legal bases do we rely on to process your personal information?",
    "4. When and with whom do we share your personal information?",
    "5. How long do we keep your information?",
    "6. How do we keep your information safe?",
    "7. What are your privacy rights?",
    "8. Controls for Do-Not-Track features",
    "9. Do United States residents have specific privacy rights?",
    "10. Do we make updates to this notice?",
    "11. How can you contact us about this notice?",
    "12. How can you review, update, or delete the data we collect from you?",
  ];

  it("has the twelve numbered sections of the notice, in order", () => {
    const html = privacy();

    const headings = [...html.matchAll(/<h2 id="[^"]+">([^<]+)<\/h2>/g)].map((match) => match[1]);
    expect(headings.filter((heading) => /^\d/.test(heading ?? ""))).toEqual(sections);
  });

  it("opens with a summary of the key points and a table of contents that lists every section", () => {
    const html = privacy();

    expect(html).toContain("<h2>Summary of key points</h2>");
    expect(html).toContain('<h2 id="contents">Table of contents</h2>');
    const contents = html.slice(html.indexOf('<h2 id="contents">'), html.indexOf('<h2 id="information">'));
    const titles = [...contents.matchAll(/<li><a href="#[^"]+">([^<]+)<\/a><\/li>/g)].map((match) => match[1]);
    expect(titles).toEqual(sections.map((section) => section.replace(/^\d+\. /, "")));
  });

  it("links only to places on the page that exist", () => {
    const html = privacy();

    const targets = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]));
    const links = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1] ?? "");
    // At least the table of contents.
    expect(links.length).toBeGreaterThan(sections.length);
    for (const link of links) expect(targets, `#${link}`).toContain(link);
  });

  it("links to the notice's own sections from its summary and from where one section refers to another", () => {
    const html = privacy();

    expect(html).toContain('<a href="#information">personal information you disclose to us</a>');
    expect(html).toContain('<a href="#withdrawing-consent">withdrawing your consent</a>');
    expect(html).toContain('<a href="#rights">section 7</a>');
  });

  it("sums up, in short, each of the sections the template does that for", () => {
    const html = privacy();

    // Sections 1 to 7, 9 and 10.
    expect(html.match(/<strong>In short:<\/strong>/g)).toHaveLength(9);
  });

  it("says it processes no sensitive information and takes none from third parties", () => {
    const html = privacy();

    expect(html).toContain("We do not process sensitive personal information.");
    expect(html).toContain("We do not collect any information from third parties.");
  });

  it("keeps the template's legal sections: GDPR bases, Canada, a UK complaint, do-not-track, US states", () => {
    const html = privacy();

    expect(html).toContain("If you are located in the EU or UK, this section applies to you.");
    expect(html).toContain("If you are located in Canada, this section applies to you.");
    expect(html).toContain("We will acknowledge your complaint within 30 days of receiving it.");
    expect(html).toContain("Information Commissioner’s Office, Wycliffe House");
    expect(html).toContain("we do not currently respond to DNT browser signals");
    expect(html).toContain("California “Shine The Light” law");
    expect(html).toContain("Oregon, Rhode Island, Tennessee, Texas, Utah, or Virginia");
  });

  it("says the notice was updated by changing its date, which is the one at the top", () => {
    expect(privacy()).toContain("an updated “Last updated” date at the top of this Privacy Notice");
  });

  it("lists a username, a password and a display name as what a person gives", () => {
    const html = privacy();

    expect(html).toContain("<li>usernames</li><li>passwords</li><li>display names</li>");
  });

  describe("the categories of personal information", () => {
    /** The table as `[category, collected]`, in order. */
    function table(html: string): [string, string][] {
      return [...html.matchAll(/<tr><th scope="row">([^<]+)<\/th><td>[^<]*<\/td><td>([^<]+)<\/td><\/tr>/g)].map(
        (match) => [match[1] ?? "", match[2] ?? ""],
      );
    }

    it("has the twelve categories, A to L", () => {
      const rows = table(privacy());

      expect(rows.map(([name]) => name.slice(0, 2))).toEqual(
        ["A.", "B.", "C.", "D.", "E.", "F.", "G.", "H.", "I.", "J.", "K.", "L."],
      );
    });

    // What the site keeps is a username, an id and tokens (and, in a host's logs, an IP address),
    // and the games people play. Anything else in the table is a No.
    it("says yes to identifiers and to network activity, which the site keeps, and no to the rest", () => {
      const rows = table(privacy());

      expect(rows.filter(([, collected]) => collected === "Yes").map(([name]) => name)).toEqual([
        "A. Identifiers",
        "F. Internet or other similar network activity",
      ]);
      expect(rows.filter(([, collected]) => collected === "No")).toHaveLength(10);
    });

    it("says what the two yeses are", () => {
      const html = privacy();

      expect(html).toContain(
        "Identifiers here are your username, your user id and access token, and the IP address in a host’s access logs.",
      );
      expect(html).toContain("Network activity is the games you play and your moves in them.");
    });
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
