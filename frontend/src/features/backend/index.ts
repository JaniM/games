import { feature } from "millpond";
import { pingBackend } from "./effects";
import { backendChecked, checkBackend } from "./ops";
import { backendHealth } from "./tables";

export const backend = feature({
  tables: { backendHealth },
  ops: { checkBackend, backendChecked },
  effects: { pingBackend },
});

// Components import definitions by value; they never need the assembled db.
export { BACKEND_ID, backendHealth } from "./tables";
export { backendChecked, checkBackend } from "./ops";
