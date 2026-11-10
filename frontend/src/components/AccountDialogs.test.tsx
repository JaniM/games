import { createDb } from "millpond";
import { DbProvider } from "millpond/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountDialogs, AccountForm, type AccountRequestRow, SignedOutNotice } from "./AccountDialogs";
import { ACCOUNT_ID, account, accountRequest } from "../features/account";
import { lobby } from "../features/lobby";
import { profile } from "../features/profile";
import { router } from "../features/router";
import { SESSION_ID, session, sessionFlags, sessionState } from "../features/session";
import { componentDb, fakeServer, fakeStorage, sessionRow, settle } from "../testing";

// What a dialog shows is a function of what is in the db, so these put the rows in and render it
// to a string. (There is no DOM here: what a press does is covered by the ops, in the account tests.)

const dbs: { dispose(): void }[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
  vi.unstubAllGlobals();
});

type Form = "create" | "signIn" | "delete";

type Overrides = Partial<Omit<AccountRequestRow, "form">>;

function requestOf(form: Form, overrides: Overrides = {}): AccountRequestRow {
  return { id: ACCOUNT_ID, form, state: "editing", username: "", password: null, error: null, ...overrides };
}

/** The form that is open, for a guest unless `isAccount`, with its request as `overrides` say. */
function render(form: Form, { isAccount = false }: { isAccount?: boolean } = {}, overrides: Overrides = {}) {
  const { db, put } = componentDb({ accountRequest, sessionState });
  dbs.push(db);
  put(accountRequest, requestOf(form, overrides));
  put(sessionState, sessionRow("user-a", isAccount ? "ada" : null));
  return renderToString(
    <DbProvider db={db}>
      <AccountForm />
    </DbProvider>,
  );
}

describe("the form to make an account", () => {
  it("asks for a username and a new password, and says what they may be", () => {
    const html = render("create");

    expect(html).toContain(">Create an account<");
    expect(html).toMatch(/name="username"[^>]*autoComplete="username"|autoComplete="username"[^>]*name="username"/i);
    expect(html).toMatch(/type="password"[^>]*/);
    expect(html).toMatch(/autoComplete="new-password"/i);
    expect(html).toContain("Letters, digits, dots, hyphens and underscores, 3 to 32 of them.");
    expect(html).toContain("The password is 8 or more characters.");
    expect(html).not.toContain("reset");
    expect(html).toMatch(/<button class="button" type="submit"[^>]*>Create account</);
  });

  it("starts with the name it is given, and the focus is on the username to be changed", () => {
    const html = render("create", {}, { username: "Countess" });

    expect(html).toContain('value="Countess"');
    expect(html).toMatch(/name="username"[^>]*data-autofocus|data-autofocus[^>]*name="username"/);
    expect(html).not.toMatch(/name="password"[^>]*data-autofocus|data-autofocus[^>]*name="password"/);
  });

  it("starts with the username empty, and the focus there too, for a guest with no name", () => {
    const html = render("create");

    expect(html).toMatch(/name="username"[^>]*data-autofocus|data-autofocus[^>]*name="username"/);
  });

  it("limits the fields to what the server takes", () => {
    const html = render("create");

    expect(html).toContain('maxLength="32"');
    expect(html).toContain('maxLength="128"');
  });

  it("does not let a browser fix up the username", () => {
    const html = render("create");

    expect(html).toContain('autoCapitalize="none"');
    expect(html).toContain('autoCorrect="off"');
    expect(html).toContain('spellCheck="false"');
  });
});

describe("the form to sign in", () => {
  it("asks for the password the browser may have saved, and says nothing else", () => {
    const html = render("signIn");

    expect(html).toContain(">Sign in<");
    expect(html).toMatch(/autoComplete="current-password"/i);
    // Only the title, the fields and the buttons: no note above them.
    expect(html).not.toContain("stay with that guest");
    expect(html).not.toContain('class="muted"');
    expect(html).toMatch(/<button class="button" type="submit"[^>]*>Sign in</);
  });

  it("starts with the username it is given, and the password is what takes the focus", () => {
    const html = render("signIn", {}, { username: "ada" });

    expect(html).toContain('value="ada"');
    expect(html).toMatch(/name="password"[^>]*data-autofocus|data-autofocus[^>]*name="password"/);
    expect(html).not.toMatch(/name="username"[^>]*data-autofocus|data-autofocus[^>]*name="username"/);
  });

  it("puts the focus on the username when there is none", () => {
    const html = render("signIn");

    expect(html).toMatch(/name="username"[^>]*data-autofocus|data-autofocus[^>]*name="username"/);
  });
});

describe("the form to delete", () => {
  it("asks an account for its password, and says what happens to the games", () => {
    const html = render("delete", { isAccount: true });

    expect(html).toContain(">Delete account<");
    expect(html).toContain('name="password"');
    expect(html).not.toContain('name="username"');
    expect(html).toContain("forfeited: they win");
    expect(html).toContain("Games against the bot, and games nobody has joined, are deleted.");
    expect(html).toContain("Deleted player");
    expect(html).toContain("can’t be undone");
    expect(html).toContain("Enter your password to confirm.");
    expect(html).toMatch(/<button class="button" type="submit"[^>]*>Delete</);
  });

  it("asks a guest for nothing", () => {
    const html = render("delete", { isAccount: false });

    expect(html).toContain(">Delete my data<");
    expect(html).not.toContain('name="password"');
    expect(html).not.toContain('name="username"');
    expect(html).toContain("start again as a new guest");
    expect(html).not.toContain("Enter your password");
  });
});

describe("while the request is on its way", () => {
  it("can't be dismissed or sent again, and says so", () => {
    const html = render("create", {}, { state: "submitting", username: "ada", password: "secret words" });

    expect(html).toContain("Creating…");
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(4);
    // The password is the form's own: nothing prints it.
    expect(html).not.toContain("secret words");
  });
});

describe("after a refusal", () => {
  it("says why, where a screen reader will hear it", () => {
    const html = render("signIn", {}, { error: "Wrong username or password." });

    expect(html).toMatch(/<p class="error" role="alert">Wrong username or password\.<\/p>/);
  });

  it("says nothing before one", () => {
    expect(render("signIn")).not.toContain('role="alert"');
  });
});

describe("the notice that the user was signed out", () => {
  it("says whose session ended and what to do", () => {
    const { db, put } = componentDb({ sessionFlags });
    dbs.push(db);
    put(sessionFlags, { id: SESSION_ID, upgrading: false, signedOutAs: "ada" });

    const html = renderToString(
      <DbProvider db={db}>
        <SignedOutNotice />
      </DbProvider>,
    );

    expect(html).toContain(">You were signed out<");
    expect(html).toContain("<strong>ada</strong>");
    expect(html).toContain("playing as a guest");
    expect(html).toMatch(/<button class="button button-quiet"[^>]*>Not now</);
    expect(html).toMatch(/<button class="button"[^>]*data-autofocus[^>]*>Sign in</);
  });
});

describe("what the page shows", () => {
  /** A browser that has opened the site, with a session. */
  async function ready() {
    const server = fakeServer();
    vi.stubGlobal("fetch", vi.fn(server.fetchImpl));
    vi.stubGlobal("localStorage", fakeStorage());
    const db = createDb({ features: { session, profile, lobby, router, account } });
    dbs.push(db);
    db.ops.session.startSession({ stored: null });
    await settle();
    return { db, server };
  }
  const page = (db: Awaited<ReturnType<typeof ready>>["db"]) =>
    renderToString(
      <DbProvider db={db}>
        <AccountDialogs />
      </DbProvider>,
    );

  it("is nothing while there is nothing to say", async () => {
    const { db } = await ready();

    expect(page(db)).toBe("");
  });

  it("is the form the user opened", async () => {
    const { db } = await ready();

    db.ops.account.openAccountForm({ form: "create" });
    expect(page(db)).toContain(">Create an account<");

    db.ops.account.closeAccountForm();
    expect(page(db)).toBe("");
  });

  it("asks a guest nothing to delete, and an account for its password", async () => {
    const { db } = await ready();
    db.ops.account.openAccountForm({ form: "delete" });
    expect(page(db)).not.toContain('name="password"');

    db.ops.session.signedIn({ userId: "user-9", accessToken: "session-9", username: "ada" });
    expect(page(db)).toContain('name="password"');
  });

  it("is the notice after a session ended, until the user signs in or lets it go", async () => {
    const { db } = await ready();
    db.ops.session.signedIn({ userId: "user-9", accessToken: "session-9", username: "ada" });
    db.ops.session.tokenRejected({ accessToken: "session-9" });

    expect(page(db)).toContain(">You were signed out<");

    db.ops.session.signedOutNoticeDismissed();
    expect(page(db)).toBe("");
  });

  it("puts a form before the notice", async () => {
    const { db } = await ready();
    db.ops.session.signedIn({ userId: "user-9", accessToken: "session-9", username: "ada" });
    db.ops.session.tokenRejected({ accessToken: "session-9" });

    db.ops.account.openAccountForm({ form: "signIn", username: "ada" });

    const html = page(db);
    expect(html).toContain(">Sign in<");
    expect(html).not.toContain("You were signed out");
  });
});
