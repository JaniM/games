import { createDb } from "millpond";
import { backend } from "./features/backend";

/**
 * The app's one db. Every table, op and effect must be registered here through
 * a feature: nothing can be added after creation.
 *
 * Without `onError`, errors from effects and subscribers are rethrown from a
 * fresh microtask, so they show up in the browser console.
 */
export const db = createDb({
  features: { backend },
});
