import { Link } from "../components/Link";

export function NotFound() {
  return (
    <main className="page">
      <header className="page-header">
        <h1>Page not found</h1>
        <p>
          There is nothing at this address. <Link to="/">Back to the games</Link>
        </p>
      </header>
    </main>
  );
}
