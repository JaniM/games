import { Link } from "./Link";

/** The privacy link, in the bottom right corner of the viewport. `App` shows it on the front page only. */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <Link to="/privacy">Privacy</Link>
    </footer>
  );
}
