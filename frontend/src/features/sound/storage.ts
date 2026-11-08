export const STORAGE_KEY = "games.volume";

/**
 * The volume saved by an earlier visit (0 to 1), or null if there is none. Storage that is
 * unavailable (blocked by the browser) or holds something else counts as empty.
 */
export function loadVolume(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // An empty string would pass for 0 below, and start the game silent.
    if (raw === null || raw.trim() === "") return null;
    const volume = Number(raw);
    return Number.isFinite(volume) && volume >= 0 && volume <= 1 ? volume : null;
  } catch {
    return null;
  }
}

/** Remembers the volume for the next visit. Never throws: this visit keeps it in memory. */
export function saveVolume(volume: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(volume));
  } catch (err) {
    console.warn("could not save the volume to local storage", err);
  }
}
