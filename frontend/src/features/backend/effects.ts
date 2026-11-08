import { effect } from "millpond";
import { backendChecked } from "./ops";
import { backendHealth } from "./tables";

/** Runs one `GET /api/health` while the health row is `checking`. */
export const pingBackend = effect({
  inputs: [backendHealth],
  watch: (q, task) =>
    q.each(backendHealth.byState.stateEq("checking"), () =>
      task(
        async ({ run, signal }) => {
          try {
            const res = await fetch("/api/health", { signal });
            run(backendChecked, { error: res.ok ? null : `HTTP ${res.status}` });
          } catch (err) {
            // An aborted task (restarted or disposed) can't write, and shouldn't try.
            if (!signal.aborted) run(backendChecked, { error: String(err) });
          }
        },
        { label: "GET /api/health" },
      ),
    ),
});
