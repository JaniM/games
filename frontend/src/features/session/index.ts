import { feature } from "millpond";
import { register } from "./effects";
import { registered, registrationFailed, startSession, tokenRejected } from "./ops";
import { sessionState } from "./tables";

export const session = feature({
  tables: { sessionState },
  ops: { startSession, registered, registrationFailed, tokenRejected },
  effects: { register },
});

// Components import definitions by value; they never need the assembled db.
export { apiFetch } from "./api";
export { loadCredentials } from "./credentials";
export { startSession } from "./ops";
export { SESSION_ID, sessionState } from "./tables";
