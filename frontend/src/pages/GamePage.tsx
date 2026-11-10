import { useOp, useQuery } from "millpond/react";
import { useEffect } from "react";
import { HEX, ULTIMATE_TIC_TAC_TOE, closeGame, gameViews, keepReview, openGame, reviews } from "../features/game";
import { gamePath } from "../features/router";
import { SESSION_ID, sessionState } from "../features/session";
import { GameScreen as HexGameScreen } from "../hex/GameScreen";
import { GameScreen, isLongBackgammonView } from "../longBackgammon/GameScreen";
import { unlockOnGesture } from "../longBackgammon/sounds";
import { GameScreen as UtttGameScreen } from "../ultimateTicTacToe/GameScreen";

/**
 * Opens a game while the page is up, and shows it. The game's link doesn't say what game it is,
 * so the page waits for the first snapshot, which does, and then draws the board of that kind of
 * game. The screen reads the rest from the db itself.
 */
export function GamePage({ gameId }: { gameId: string }) {
  const view = useQuery(gameViews.get(gameId));
  const review = useQuery(reviews.get(gameId));
  const userId = useQuery(sessionState.get(SESSION_ID))?.userId ?? null;
  const open = useOp(openGame);
  const close = useOp(closeGame);
  const keepReviewOn = useOp(keepReview);

  // A browser lets a page make sound only after it has been used: be ready for the first press.
  useEffect(unlockOnGesture, []);

  // A game that is over, and one the user only watches, is always in review: open it for them,
  // and again when it changes (it ended, it had its first move) or the review is gone. It is cheap
  // and does nothing for a game that isn't one of those.
  const revision = view?.snapshot?.revision;
  const reviewing = review !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are what the call is for, though it reads them from the db.
  useEffect(() => {
    keepReviewOn({ gameId, userId });
  }, [keepReviewOn, gameId, userId, revision, reviewing]);

  // Open the game while this page shows it, and close it (and its socket) on the way out.
  // `useOp` gives the same function until the db changes, so this runs once per game id.
  useEffect(() => {
    open({ gameId });
    return () => close({ gameId });
  }, [gameId, open, close]);

  // What every kind of game's screen is given.
  const screen = {
    gameId,
    inviteUrl: `${location.origin}${gamePath(gameId)}`,
    // Only in development: `import.meta.env.DEV` is false in `vite build`, and the button is left out.
    showAutoplay: import.meta.env.DEV,
  };

  if (view?.snapshot?.kind === ULTIMATE_TIC_TAC_TOE) return <UtttGameScreen {...screen} />;
  if (view?.snapshot?.kind === HEX) return <HexGameScreen {...screen} />;
  // Long backgammon, which is also what shows the page until the first snapshot says what it is.
  if (view === undefined || isLongBackgammonView(view)) return <GameScreen {...screen} />;
  return null;
}
