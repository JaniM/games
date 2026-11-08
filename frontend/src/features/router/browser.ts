/** Puts `path` in the address bar as a new history entry, without reloading. */
export function pushPath(path: string): void {
  history.pushState(null, "", path);
}

/**
 * Keeps the router's row in step with the address bar: reports the current path now,
 * and again on every back or forward. Returns a function that stops listening.
 * Programmatic navigation reports itself (see `useNavigate`), because `pushState`
 * fires no event.
 */
export function bindBrowserLocation(
  setPath: (args: { path: string }) => void,
  win: Pick<Window, "addEventListener" | "removeEventListener" | "location"> = window,
): () => void {
  const report = () => setPath({ path: win.location.pathname });
  report();
  win.addEventListener("popstate", report);
  return () => win.removeEventListener("popstate", report);
}
