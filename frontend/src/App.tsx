import { useOp, useQuery } from "millpond/react";
import { BACKEND_ID, backendHealth, checkBackend } from "./features/backend";

export function App() {
  return (
    <main>
      <h1>Games</h1>
      <BackendStatus />
    </main>
  );
}

function BackendStatus() {
  // Rebuilding the query every render is free: equal queries share a subscription.
  const health = useQuery(backendHealth.get(BACKEND_ID));
  const check = useOp(checkBackend);

  const label =
    health === undefined || health.state === "checking"
      ? "Checking…"
      : health.state === "ok"
        ? "Backend is up"
        : `Backend is down (${health.error})`;

  return (
    <p>
      {label}{" "}
      <button type="button" onClick={() => check()} disabled={health?.state === "checking"}>
        Check again
      </button>
    </p>
  );
}
