import { feature } from "millpond";
import { register } from "./effects";
import {
  becameGuest,
  registered,
  registrationFailed,
  signedIn,
  signedOutNoticeDismissed,
  startSession,
  tokenRejected,
  upgradeFailed,
  upgradeStarted,
} from "./ops";
import { sessionFlags, sessionState } from "./tables";

export const session = feature({
  tables: { sessionState, sessionFlags },
  ops: {
    startSession,
    registered,
    registrationFailed,
    tokenRejected,
    signedIn,
    becameGuest,
    upgradeStarted,
    upgradeFailed,
    signedOutNoticeDismissed,
  },
  effects: { register },
});

// Components import definitions by value; they never need the assembled db.
export { apiFetch } from "./api";
export { type Credentials, clearCredentials, credentialsSchema, loadCredentials, saveCredentials } from "./credentials";
export {
  becameGuest,
  signedIn,
  signedOutNoticeDismissed,
  startSession,
  tokenRejected,
  upgradeFailed,
  upgradeStarted,
} from "./ops";
export { SESSION_ID, sessionFlags, sessionState } from "./tables";
