import { table } from "millpond";
import { z } from "zod";

/** The singleton key of the one `backendHealth` row. */
export const BACKEND_ID = "api";

/**
 * Whether the backend answers `/api/health`. A single row; `state: "checking"`
 * is the request the `pingBackend` effect picks up, so loading and failure are
 * ordinary data the UI can query.
 */
export const backendHealth = table(
  z.object({
    id: z.string(),
    state: z.enum(["checking", "ok", "down"]),
    /** `Date.now()` of the last finished check, or null before the first. */
    checkedAt: z.number().nullable(),
    /** Why the last check failed, or null. */
    error: z.string().nullable(),
  }),
  { key: "id", indexes: { byState: ["state"] } },
);
