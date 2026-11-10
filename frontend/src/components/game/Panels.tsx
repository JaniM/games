import type { ReactElement, ReactNode } from "react";
import { Link } from "../Link";
import { Loading } from "../Loading";
import { gamePath } from "../../features/router";
import type { RematchStage, Result } from "./people";
import type { AnyGameViewRow, JoinRequestRow } from "./rows";

/** The page of a game: a screen reader gets the title, because the nav and the board say the rest. */
export function GameShell({ title, shape, children }: { title: string; shape?: "square"; children: ReactNode }) {
  return (
    <main className={shape === "square" ? "page game-page game-page-square" : "page game-page"}>
      <h1 className="visually-hidden">{title}</h1>
      {children}
    </main>
  );
}

/**
 * What a game page says while it has no game to draw: that there is none, why the one it has
 * can't be shown, or that it is still connecting. Null once there is a snapshot and nothing wrong.
 * The title is neutral: it is not known what game the page is for until a snapshot arrives.
 */
export function gameNotice(view: AnyGameViewRow | undefined): ReactElement | null {
  if (view?.connection === "missing") {
    return (
      <GameShell title="Game">
        <p role="alert">There is no game at this link. Check the link, or start a new game.</p>
      </GameShell>
    );
  }
  if (view?.problem) {
    return (
      <GameShell title="Game">
        <p role="alert">{view.problem}</p>
      </GameShell>
    );
  }
  if (!view?.snapshot) {
    return (
      <GameShell title="Game">
        <Loading role="status">Connecting to the game…</Loading>
      </GameShell>
    );
  }
  return null;
}

interface JoinPanelProps {
  connected: boolean;
  join: JoinRequestRow | undefined;
  onJoin: () => void;
}

/** The free seat, and the button to take it. The point of the page for a visitor until the game is full. */
export function JoinPanel({ connected, join, onJoin }: JoinPanelProps) {
  return (
    <section className="panel" aria-label="Join this game">
      <p>This game is waiting for a second player.</p>
      <button className="button" type="button" disabled={!connected || join?.state === "joining"} onClick={onJoin}>
        {join?.state === "joining" ? "Joining…" : "Join game"}
      </button>
      {join?.state === "failed" && (
        <p className="error" role="alert">
          {`Could not join: ${join.error}`}
        </p>
      )}
      <p className="muted">Or just watch: anyone with this link can.</p>
    </section>
  );
}

interface ResultSectionProps {
  result: Result;
  rematch: RematchStage;
  connected: boolean;
  /** The player's own answer about the rematch has gone out, and the other's is not back. */
  answering: boolean;
  /** Why the last answer about the rematch did not go through, if it did not. */
  rematchProblem: string | null;
  onRematch: () => void;
  onDeclineRematch: () => void;
}

/** The game over block: who won, and what the players can do next: ask for a rematch. */
export function ResultSection({
  result,
  rematch,
  connected,
  answering,
  rematchProblem,
  onRematch,
  onDeclineRematch,
}: ResultSectionProps) {
  return (
    <section className={result.won ? "result result-won" : "result"} aria-label="Result">
      <div>
        <p className="result-kicker">Game over</p>
        <p className="result-title" role="status">
          {result.title}
        </p>
        {/* One line, always there, for how it ended and where the rematch stands (see `.result`). */}
        <div className="result-notes">
          {result.detail && <p className="result-detail">{result.detail}</p>}
          {/* Always there, so that a screen reader hears it when the other player answers. What went
              wrong takes its place on the screen: the line holds one thing about the rematch. */}
          <p
            className={
              rematchProblem
                ? "result-rematch visually-hidden"
                : rematch.stage === "answer"
                  ? "result-rematch result-rematch-due"
                  : "result-rematch"
            }
            role="status"
          >
            {rematch.line}
          </p>
          {rematchProblem && (
            <p className="result-rematch result-rematch-due" role="alert">
              {rematchProblem}
            </p>
          )}
        </div>
      </div>
      {/* Someone who only watches has nothing to press. */}
      {rematch.stage !== "closed" && (
        <div className="result-actions">
          {rematch.stage === "ask" && (
            <button className="button" type="button" disabled={!connected || answering} onClick={onRematch}>
              Rematch
            </button>
          )}
          {rematch.stage === "answer" && (
            <>
              <button className="button" type="button" disabled={!connected || answering} onClick={onRematch}>
                Accept
              </button>
              <button
                className="button button-quiet"
                type="button"
                disabled={!connected || answering}
                onClick={onDeclineRematch}
              >
                Decline
              </button>
            </>
          )}
          {rematch.stage === "waiting" && (
            <button
              className="button button-quiet"
              type="button"
              disabled={!connected || answering}
              onClick={onDeclineRematch}
            >
              Cancel
            </button>
          )}
          {rematch.stage === "started" && (
            <Link className="button" to={gamePath(rematch.gameId)}>
              Go to the rematch
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
