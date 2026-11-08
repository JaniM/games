import { DbProvider } from "millpond/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { db } from "./db";
import { loadCredentials } from "./features/session";
import "./styles.css";

// Initial data comes from ops. This one inserts the health row and starts the first check.
db.ops.backend.checkBackend();
// Reuses the access token saved by an earlier visit, or registers a new user.
db.ops.session.startSession({ stored: loadCredentials() });

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <DbProvider db={db}>
      <App />
    </DbProvider>
  </StrictMode>,
);
