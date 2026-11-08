import { op } from "millpond";
import { LOCATION_ID, locationState } from "./tables";

/**
 * Records the path the browser is now on. Call it after every `history.pushState`
 * (see `navigate`) and on `popstate`, so the row never disagrees with the address bar.
 */
export const pathChanged = op((tx, args: { path: string }) => {
  tx.upsert(locationState, { id: LOCATION_ID, path: args.path });
});
