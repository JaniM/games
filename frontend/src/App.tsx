import { GAMES, gameHref } from "./games";
import { NameControl } from "./NameControl";

export function App() {
  return (
    <main className="page">
      <div className="top-right">
        <NameControl />
      </div>

      <header className="page-header">
        <h1>Games</h1>
        <p>Simple board games, played live or at your own pace.</p>
      </header>

      <ul className="game-list">
        {GAMES.map((game) => (
          <li key={game.id}>
            <a className="game-card" href={gameHref(game)}>
              <h2>{game.name}</h2>
              <p>{game.description}</p>
              <span className="game-card-footer">
                <span>{game.players}</span>
                <span className="game-card-play" aria-hidden="true">
                  Play →
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
