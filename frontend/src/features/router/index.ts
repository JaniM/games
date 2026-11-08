import { feature } from "millpond";
import { pathChanged } from "./ops";
import { locationState } from "./tables";

export const router = feature({
  tables: { locationState },
  ops: { pathChanged },
});

// Components import definitions by value; they never need the assembled db.
export { bindBrowserLocation, pushPath } from "./browser";
export { pathChanged } from "./ops";
export { gamePath, parseRoute, type Route } from "./routes";
export { LOCATION_ID, locationState } from "./tables";
