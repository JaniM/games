import { DbProvider } from "millpond/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AccountMenu } from "./AccountMenu";
import { ACCOUNT_ID, accountRequest } from "../features/account";
import { PROFILE_ID, profileState } from "../features/profile";
import { sessionState } from "../features/session";
import { SOUND_ID, soundSettings } from "../features/sound";
import { THEME_ID, type Theme, themeSettings } from "../features/theme";
import { componentDb, sessionRow } from "../testing";

// What the menu shows is a function of what is in the db, so these put the rows in and render it
// to a string. There is no DOM here: what the buttons do is covered by the ops they call, in the
// account tests, and the key that closes the menu by `closesMenu`.

const dbs: { dispose(): void }[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
});

interface Menu {
  /** A guest's display name, null for none. An account's name is its username. */
  name: string | null;
  /** An account's username; null for a guest. */
  username: string | null;
  /** A request about the account is on its way. */
  busy: boolean;
  /** The volume, on a page with sound (a game's); null for a page with none. */
  volume: number | null;
  theme: Theme;
}

/** The menu of Ada, a guest, on a page without sound, unless `overrides` say otherwise. */
function render(overrides: Partial<Menu> = {}) {
  const menu: Menu = { name: "Ada", username: null, busy: false, volume: null, theme: "system", ...overrides };
  const { db, put } = componentDb({ accountRequest, profileState, sessionState, soundSettings, themeSettings });
  dbs.push(db);
  put(sessionState, sessionRow("user-a", menu.username));
  // As loaded: the name button can be pressed.
  put(profileState, { id: PROFILE_ID, name: menu.name, state: "idle", pending: null, error: null });
  if (menu.busy) {
    put(accountRequest, {
      id: ACCOUNT_ID,
      form: "signOut",
      state: "submitting",
      username: "",
      password: null,
      error: null,
    });
  }
  if (menu.volume !== null) put(soundSettings, { id: SOUND_ID, volume: menu.volume });
  put(themeSettings, { id: THEME_ID, theme: menu.theme });
  return renderToString(
    <DbProvider db={db}>
      <AccountMenu showSound={menu.volume !== null} />
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
    expect(render({ username: null })).not.toMatch(/class="menu-item"[^>]*disabled/);
  });
});

describe("the volume", () => {
  it("has no slider on a page with no sound", () => {
    const html = render();

    expect(html).not.toContain("volume");
    expect(html).not.toContain("type=\"range\"");
  });

  it("is a slider in the panel, set to the volume it is given, closed until the menu is opened", () => {
    const html = render({ volume: 0.5 });

    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html.indexOf("<details")).toBeLessThan(html.indexOf("volume-slider"));
    expect(html.indexOf("volume-slider")).toBeLessThan(html.indexOf("</details>"));
    expect(html).toMatch(/<input[^>]*type="range"[^>]*value="10"/);
    expect(html).toContain("aria-valuetext=\"50%\"");
    expect(html).toContain(">Sound<");
  });

  it("calls the left end of the slider Off", () => {
    expect(render({ volume: 0 })).toContain("aria-valuetext=\"Off\"");
  });

  it("is the first thing in the list, above what the account can do", () => {
    const html = render({ volume: 0.7 });

    expect(html.indexOf("volume-slider")).toBeLessThan(html.indexOf("Create account"));
    expect(html.indexOf("volume-slider")).toBeLessThan(html.indexOf("Delete my data"));
    // A row of the list, between hairlines like the buttons.
    expect(html).toMatch(/<li class="menu-row"><label class="volume">/);
  });

  it("is there for an account as well as a guest", () => {
    const html = render({ volume: 0.7, username: "ada" });

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
      const html = render({ theme });

      expect(html.match(/checked=""/g), theme).toHaveLength(1);
      const match = picked(html);
      expect(match?.[1] ?? match?.[2], theme).toBe(theme);
    }
  });

  it("is a row of the list, after the volume and above what the account can do", () => {
    const html = render({ volume: 0.7 });

    expect(html).toMatch(/<li class="menu-row"><div class="theme"/);
    expect(html.indexOf("volume-slider")).toBeLessThan(html.indexOf('class="theme"'));
    expect(html.indexOf('class="theme"')).toBeLessThan(html.indexOf("Create account"));
  });

  it("is there for an account as well as a guest", () => {
    expect(render({ username: "ada" })).toContain('class="theme"');
  });
});
