import { createDb } from "millpond";
import { account } from "./features/account";
import { backend } from "./features/backend";
import { game } from "./features/game";
import { lobby } from "./features/lobby";
import { profile } from "./features/profile";
import { router } from "./features/router";
import { session } from "./features/session";
import { sound } from "./features/sound";
import { theme } from "./features/theme";

/**
 * The app's one db. Every table, op and effect must be registered here through
 * a feature: nothing can be added after creation.
 *
 * Without `onError`, errors from effects and subscribers are rethrown from a
 * fresh microtask, so they show up in the browser console.
 */
export const db = createDb({
  features: { account, backend, game, lobby, profile, router, session, sound, theme },
});
