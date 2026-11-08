import { table } from "millpond";
import { z } from "zod";

/** The singleton key of the one `profileState` row. */
export const PROFILE_ID = "me";

/**
 * The signed-in user's display name, as the server has it. A single row, created
 * when the session becomes ready, so it is absent until the first load starts.
 * `state` is the request an effect picks up, so loading and failure are ordinary
 * data the UI can query:
 *
 * - `loading`: the `loadProfile` effect is fetching the name.
 * - `idle`: `name` is what the server has (null if no name is set). `error` says
 *   why the last load or save failed, or is null.
 * - `saving`: the `saveName` effect is sending `pending`. `name` is still the old one.
 */
export const profileState = table(
  z.object({
    id: z.string(),
    name: z.string().nullable(),
    state: z.enum(["loading", "idle", "saving"]),
    /** The name being saved while `state` is `saving`, otherwise null. */
    pending: z.string().nullable(),
    error: z.string().nullable(),
  }),
  { key: "id", indexes: { byState: ["state"] } },
);
