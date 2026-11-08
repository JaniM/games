import { effect } from "millpond";
import { credentialsSchema, saveCredentials } from "./credentials";
import { registered, registrationFailed } from "./ops";
import { sessionState } from "./tables";

/** Runs one `POST /api/register` while the session row is `registering`. */
export const register = effect({
  inputs: [sessionState],
  watch: (q, task) =>
    q.each(sessionState.byState.stateEq("registering"), () =>
      task(
        async ({ run, signal }) => {
          try {
            const res = await fetch("/api/register", { method: "POST", signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const credentials = credentialsSchema.parse(await res.json());
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
