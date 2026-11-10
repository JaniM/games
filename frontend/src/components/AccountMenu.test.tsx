import { createDb } from "millpond";
import { DbProvider } from "millpond/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AccountMenuView, type AccountMenuViewProps } from "./AccountMenu";
import { profile } from "../features/profile";
import { session } from "../features/session";

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
        sound={null}
        theme={{ theme: "system", onChange: noop }}
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

describe("the volume", () => {
  const sound = (volume: number) => ({ volume, onChange: () => {}, onSettle: () => {} });

  it("has no slider on a page with no sound", () => {
    const html = render();

    expect(html).not.toContain("volume");
    expect(html).not.toContain("type=\"range\"");
  });

  it("is a slider in the panel, set to the volume it is given, closed until the menu is opened", () => {
    const html = render({ sound: sound(0.5) });

    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html.indexOf("<details")).toBeLessThan(html.indexOf("volume-slider"));
    expect(html.indexOf("volume-slider")).toBeLessThan(html.indexOf("</details>"));
    expect(html).toMatch(/<input[^>]*type="range"[^>]*value="10"/);
    expect(html).toContain("aria-valuetext=\"50%\"");
    expect(html).toContain(">Sound<");
  });

  it("calls the left end of the slider Off", () => {
    expect(render({ sound: sound(0) })).toContain("aria-valuetext=\"Off\"");
  });

  it("is the first thing in the list, above what the account can do", () => {
    const html = render({ sound: sound(0.7) });

    expect(html.indexOf("volume-slider")).toBeLessThan(html.indexOf("Create account"));
    expect(html.indexOf("volume-slider")).toBeLessThan(html.indexOf("Delete my data"));
    // A row of the list, between hairlines like the buttons.
    expect(html).toMatch(/<li class="menu-row"><label class="volume">/);
  });

  it("is there for an account as well as a guest", () => {
    const html = render({ sound: sound(0.7), username: "ada" });

    expect(html).toContain("volume-slider");
    expect(html).toContain("Sign out");
  });
});

describe("the theme", () => {
  const picked = (html: string) => html.match(/<input[^>]*checked=""[^>]*value="(\w+)"|<input[^>]*value="(\w+)"[^>]*checked=""/);

  it("is a choice of Auto, Light and Dark in the panel, on a page with no sound too", () => {
    const html = render();

    expect(html.indexOf("<details")).toBeLessThan(html.indexOf("Theme"));
    expect(html.indexOf("Theme")).toBeLessThan(html.indexOf("</details>"));
    expect(html).toContain('role="radiogroup" aria-labelledby="theme-label"');
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    for (const name of ["Auto", "Light", "Dark"]) expect(html).toContain(`>${name}</span>`);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  it("has the theme it is given picked, and only that", () => {
    for (const theme of ["system", "light", "dark"] as const) {
      const html = render({ theme: { theme, onChange: () => {} } });

      expect(html.match(/checked=""/g), theme).toHaveLength(1);
      const match = picked(html);
      expect(match?.[1] ?? match?.[2], theme).toBe(theme);
    }
  });

  it("is a row of the list, after the volume and above what the account can do", () => {
    const html = render({ sound: { volume: 0.7, onChange: () => {}, onSettle: () => {} } });

    expect(html).toMatch(/<li class="menu-row"><div class="theme"/);
    expect(html.indexOf("volume-slider")).toBeLessThan(html.indexOf('class="theme"'));
    expect(html.indexOf('class="theme"')).toBeLessThan(html.indexOf("Create account"));
  });

  it("is there for an account as well as a guest", () => {
    expect(render({ username: "ada" })).toContain('class="theme"');
  });
});
