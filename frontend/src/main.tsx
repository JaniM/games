import { DbProvider } from "millpond/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { db } from "./db";
import { loadPublic } from "./features/lobby";
import { bindBrowserLocation } from "./features/router";
import { loadCredentials } from "./features/session";
import { loadVolume } from "./features/sound";
import { loadTheme } from "./features/theme";
import "./styles/index.css";

// Initial data comes from ops. This one inserts the health row and starts the first check.
db.ops.backend.checkBackend();
// Reuses the access token saved by an earlier visit, or registers a new user.
db.ops.session.startSession({ stored: loadCredentials() });
// The volume the last visit ended on, or the default.
db.ops.sound.startSound({ stored: loadVolume() });
// The theme the last visit ended on, or to follow the device.
db.ops.theme.startTheme({ stored: loadTheme() });
// Whether the last visit left a new game public, or the default.
db.ops.lobby.startLobby({ stored: loadPublic() });
// Reports the page we opened on, and every back or forward after it.
bindBrowserLocation(db.ops.router.pathChanged);

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <DbProvider db={db}>
      <App />
    </DbProvider>
  </StrictMode>,
);
