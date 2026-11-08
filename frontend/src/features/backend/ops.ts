import { op } from "millpond";
import { BACKEND_ID, backendHealth } from "./tables";

/** Requests a health check. Calling it while one is running restarts it. */
export const checkBackend = op((tx) => {
  tx.upsert(backendHealth, { id: BACKEND_ID, state: "checking", checkedAt: null, error: null });
});

/** Records a finished check. `error` is null on success. */
export const backendChecked = op((tx, result: { error: string | null }) => {
  tx.update(backendHealth, BACKEND_ID, {
    state: result.error === null ? "ok" : "down",
    checkedAt: Date.now(),
    error: result.error,
  });
});
