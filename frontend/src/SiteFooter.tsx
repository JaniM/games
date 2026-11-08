import { Link } from "./Link";

/** The foot of every page: the links that belong on all of them. */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <Link to="/privacy">Privacy</Link>
    </footer>
  );
}
