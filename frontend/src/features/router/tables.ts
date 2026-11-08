import { table } from "millpond";
import { z } from "zod";

/** The singleton key of the one `locationState` row. */
export const LOCATION_ID = "current";

/**
 * The page the browser is on: the path of `window.location`, without the query or
 * hash. A single row, absent until `bindBrowserLocation` reports the first path.
 * `parseRoute` turns the path into the page to show.
 */
export const locationState = table(z.object({ id: z.string(), path: z.string() }), {
  key: "id",
});
