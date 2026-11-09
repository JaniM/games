import { Link } from "./Link";

/** Which page the nav is on, so that it can say where you are. */
export type NavPage = "home" | "games" | "other";

export interface SiteNavProps {
  page: NavPage;
}

/**
 * The links at the top left corner of a page: home, and "Watch", the public list. The page you
 * are on is marked, for a screen reader and for the eye. `App` shows it on every page.
 */
export function SiteNav({ page }: SiteNavProps) {
  return (
    <nav className="site-nav" aria-label="Site">
      <Link to="/" aria-current={page === "home" ? "page" : undefined}>
        Home
      </Link>
      <Link to="/games" aria-current={page === "games" ? "page" : undefined}>
        Watch
      </Link>
    </nav>
  );
}
