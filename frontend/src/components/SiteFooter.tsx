import { Link } from "./Link";

/**
 * The privacy link, at the bottom right: the bottom of the screen on a short page, the end of
 * the page on a long one. `App` shows it on the front page only.
 */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <Link to="/privacy">Privacy</Link>
    </footer>
  );
}
