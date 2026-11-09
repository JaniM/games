import { effect } from "millpond";
import { credentialsSchema, loadCredentials, saveCredentials } from "./credentials";
import { registered, registrationFailed } from "./ops";
import { sessionState } from "./tables";

/**
 * Gets credentials while the session row is `registering`: runs one `POST /api/register`, or
 * takes up the credentials that another tab of this browser has saved since.
 *
 * Two tabs are one browser. When the server refuses a token (an account's session that expired,
 * or the guest token an account just retired in the other tab), the other tab may have got
 * new credentials already, and registering again here would overwrite them in storage. So saved
 * credentials are used, unless they are the very token that was refused.
 */
export const register = effect({
  inputs: [sessionState],
  watch: (q, task) =>
    q.each(sessionState.byState.stateEq("registering"), (row) =>
      task(
        async ({ run, signal }) => {
          const saved = loadCredentials();
          if (saved && saved.accessToken !== row.rejected) {
            run(registered, saved);
            return;
          }
          try {
            const res = await fetch("/api/register", { method: "POST", signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const credentials = credentialsSchema.parse(await res.json());
            // Not if the session moved on while the answer was on its way (the user signed in):
            // what is saved is theirs now.
            if (signal.aborted) return;
            // Save before recording, so the next visit finds them even if this one ends here.
            saveCredentials(credentials);
            run(registered, credentials);
          } catch (err) {
            // An aborted task (restarted or disposed) can't write, and shouldn't try.
            if (!signal.aborted) run(registrationFailed, { error: String(err) });
          }
        },
        { label: "POST /api/register" },
      ),
    ),
});
