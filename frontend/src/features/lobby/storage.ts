export const STORAGE_KEY = "games.public";

/**
 * Whether the last visit left "public game" ticked in the new game dialog, or null if there is
 * no choice saved. Storage that is unavailable (blocked by the browser) or holds something else
 * counts as empty.
 */
export function loadPublic(): boolean | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "true" ? true : raw === "false" ? false : null;
  } catch {
    return null;
  }
}

/** Remembers the choice for the next visit. Never throws: this visit keeps it in memory. */
export function savePublic(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch (err) {
    console.warn("could not save the choice of a public game to local storage", err);
  }
}
