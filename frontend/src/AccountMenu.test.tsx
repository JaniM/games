import { createDb } from "millpond";
import { DbProvider } from "millpond/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AccountMenuView, type AccountMenuViewProps } from "./AccountMenu";
import { profile } from "./features/profile";
import { session } from "./features/session";

// What the menu shows is a function of its props (the name field aside, which reads the profile),
// so these render it to a string. There is no DOM here: what the buttons do is covered by the ops
// they call, in the account tests, and the key that closes the menu by `closesMenu`.

const dbs: { dispose(): void }[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
});

function render(overrides: Partial<AccountMenuViewProps> = {}) {
  const db = createDb({ features: { session, profile } });
  dbs.push(db);
  const noop = () => {};
  return renderToString(
    <DbProvider db={db}>
      <AccountMenuView
        name="Ada"
        username={null}
        busy={false}
        onCreate={noop}
        onSignIn={noop}
        onSignOut={noop}
        onDelete={noop}
        {...overrides}
      />
    </DbProvider>,
  );
}

describe("the button", () => {
  it("says the display name, cut short if it is long", () => {
    expect(render({ name: "Ada" })).toMatch(/<summary[^>]*><span class="options-label options-label-clipped">Ada<\/span><\/summary>/);
  });

  it("says Account for someone with no name", () => {
    expect(render({ name: null })).toContain(">Account</span>");
  });

  it("does not let a name be taken for markup", () => {
    const html = render({ name: "<img src=x>" });

    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img src=x>");
  });
});

describe("the panel", () => {
  it("lines up with the right corner and holds the name to change", () => {
    const html = render();

    expect(html).toContain('class="options-panel options-panel-end"');
    expect(html).toContain("Display name");
    // The name field is the profile's, which has not loaded here.
    expect(html).toContain('class="name-button"');
  });

  it("lets a guest change their name, and says they are a guest", () => {
    const html = render({ username: null });

    expect(html).toContain("Display name");
    expect(html).toContain('class="name-button"');
    expect(html).toContain("You are playing as a guest.");
    expect(html).not.toContain("after your name");
    expect(html).not.toContain("Username");
  });

  it("offers a guest an account or a sign-in", () => {
    const html = render({ username: null });

    expect(html).toMatch(/<button[^>]*>Create account</);
    expect(html).toMatch(/<button[^>]*>Sign in</);
    expect(html).toMatch(/<button[^>]*>Delete my data</);
    expect(html).not.toContain("Sign out");
    expect(html).not.toContain("Signed in as");
  });

  it("shows an account its username as its name, as text that can't be changed", () => {
    const html = render({ name: "ada", username: "ada" });

    expect(html).toContain("Username");
    expect(html).toContain('<p class="account-name">ada</p>');
    // No field, no button to change it.
    expect(html).not.toContain('class="name-button"');
    expect(html).not.toContain("name-input");
    expect(html).not.toContain("Display name");
  });

  it("offers an account to sign out, and no account or sign-in", () => {
    const html = render({ username: "ada" });

    expect(html).toMatch(/<button[^>]*>Sign out</);
    expect(html).toMatch(/<button[^>]*>Delete account</);
    expect(html).not.toContain("Create account");
    expect(html).not.toMatch(/<button[^>]*>Sign in</);
    expect(html).not.toContain("(guest)");
  });

  it("does not let a username be taken for markup", () => {
    expect(render({ username: "<b>x</b>" })).not.toContain("<b>x</b>");
  });

  it("holds every action back while a request is on its way", () => {
    const html = render({ username: null, busy: true });

    expect(html.match(/<button class="menu-item" type="button" disabled=""/g)).toHaveLength(3);
    // (The name button is held back until the profile loads, which it hasn't here.)
    expect(render({ username: null })).not.toMatch(/class="menu-item"[^>]*disabled/);
  });
});
