// Stands in for `Loading` in the tests that render a page to a string. The real one holds its text
// back for a second, and a render never gets that far. This one says it at once, which shows whether
// the page is waiting. A test file swaps it in with
// `vi.mock("../Loading", () => import("../immediateLoading"))` (paths as seen from that file).

import type { LoadingProps } from "./Loading";

export function Loading({ className, role, children = "Loading…" }: LoadingProps) {
  return (
    <p className={className} role={role}>
      {children}
    </p>
  );
}
