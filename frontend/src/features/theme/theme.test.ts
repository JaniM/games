import { createDb } from "millpond";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeStorage, settle } from "../../testing";
import { DEFAULT_THEME, THEME_ID, theme, themeSettings } from "./index";
import { STORAGE_KEY, loadTheme } from "./storage";

/** The root element of the page, as far as the theme touches it. */
function fakeDocument() {
  return { documentElement: { dataset: {} as Record<string, string | undefined> } };
}

const dbs: { dispose(): void }[] = [];
function setup(storage = fakeStorage()) {
  const page = fakeDocument();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("document", page);
  const db = createDb({ features: { theme } });
  dbs.push(db);
  return { db, storage, shown: () => page.documentElement.dataset.theme };
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
  vi.unstubAllGlobals();
});

const chosen = (db: ReturnType<typeof setup>["db"]) => db.read(themeSettings.get(THEME_ID))?.theme;

describe("the theme", () => {
  it("follows the device when nothing was saved", () => {
    const { db } = setup();
    db.ops.theme.startTheme({ stored: loadTheme() });

    expect(chosen(db)).toBe(DEFAULT_THEME);
    expect(DEFAULT_THEME).toBe("system");
  });

  it("starts as the last visit ended, light or dark", () => {
    for (const saved of ["light", "dark", "system"] as const) {
      const { db } = setup(fakeStorage({ [STORAGE_KEY]: saved }));
      db.ops.theme.startTheme({ stored: loadTheme() });

      expect(chosen(db), saved).toBe(saved);
    }
  });

  it("follows the device when what was saved makes no sense", () => {
    for (const junk of ["", "Dark", "blue", "1", "null"]) {
      const { db } = setup(fakeStorage({ [STORAGE_KEY]: junk }));
      db.ops.theme.startTheme({ stored: loadTheme() });

      expect(chosen(db), junk).toBe("system");
    }
  });

  it("keeps the choice made before startup finishes", () => {
    const { db } = setup();
    db.ops.theme.setTheme({ theme: "dark" });
    db.ops.theme.startTheme({ stored: "light" });

    expect(chosen(db)).toBe("dark");
  });

  it("is saved when it is picked, and Auto is saved too, so that it can be picked again", async () => {
    const { db, storage } = setup();

    db.ops.theme.setTheme({ theme: "dark" });
    await settle();
    expect(storage.data.get(STORAGE_KEY)).toBe("dark");

    db.ops.theme.setTheme({ theme: "system" });
    await settle();
    expect(storage.data.get(STORAGE_KEY)).toBe("system");
  });

  it("is put on the page when it is picked, and taken off for Auto", async () => {
    const { db, shown } = setup();

    db.ops.theme.setTheme({ theme: "dark" });
    await settle();
    expect(shown()).toBe("dark");

    db.ops.theme.setTheme({ theme: "light" });
    await settle();
    expect(shown()).toBe("light");

    db.ops.theme.setTheme({ theme: "system" });
    await settle();
    expect(shown()).toBeUndefined();
  });

  it("is put on the page at startup", async () => {
    const { db, shown } = setup(fakeStorage({ [STORAGE_KEY]: "dark" }));
    db.ops.theme.startTheme({ stored: loadTheme() });
    await settle();

    expect(shown()).toBe("dark");
  });

  it("works from memory when storage cannot be written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, shown } = setup(fakeStorage({}, true));
    db.ops.theme.setTheme({ theme: "dark" });
    await settle();

    expect(chosen(db)).toBe("dark");
    expect(shown()).toBe("dark");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("works when storage cannot even be read", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
    });

    expect(loadTheme()).toBeNull();
  });
});
