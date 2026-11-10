import { THEMES, type Theme } from "./tables";

/**
 * Also read by the script in `index.html`, which puts the theme on the page before it is first
 * drawn: the two must name the same key and the same values.
 */
export const STORAGE_KEY = "games.theme";

/**
 * The theme chosen on an earlier visit, or null if there is none. Storage that is unavailable
 * (blocked by the browser) or holds something else counts as empty.
 */
export function loadTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return THEMES.find((theme) => theme === raw) ?? null;
  } catch {
    return null;
  }
}

/** Remembers the theme for the next visit. Never throws: this visit keeps it in memory. */
export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch (err) {
    console.warn("could not save the theme to local storage", err);
  }
}
