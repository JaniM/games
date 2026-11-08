import { z } from "zod";

/** What `POST /api/register` returns, and what we keep in local storage. */
export const credentialsSchema = z.object({
  userId: z.string().min(1),
  accessToken: z.string().min(1),
});

export type Credentials = z.infer<typeof credentialsSchema>;

export const STORAGE_KEY = "games.session";

/**
 * The credentials saved by an earlier visit, or null if there are none. Storage
 * that is unavailable (blocked by the browser) or holds something unreadable
 * counts as empty, which makes the caller register again.
 */
export function loadCredentials(): Credentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = credentialsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Remembers the credentials for the next visit. Never throws: if storage is
 * unavailable or full, this visit still works from memory, and the next one
 * registers a new user.
 */
export function saveCredentials(credentials: Credentials): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
  } catch (err) {
    console.warn("could not save the session to local storage", err);
  }
}
