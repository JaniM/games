import { useOp, useQuery } from "millpond/react";
import { useEffect } from "react";
import {
  ULTIMATE_TIC_TAC_TOE,
  askRematch,
  closeGame,
  closeReview,
  declineRematch,
  forfeitGame,
  gameViews,
  joinGame,
  joinRequests,
  keepReview,
  openGame,
  openReview,
  rematchRequests,
  retryReview,
  reviews,
  selectPoint,
  setAutoplay,
  showFrame,
  stepFrame,
  submitAction,
  submitMoves,
} from "../features/game";
import { gamePath } from "../features/router";
import { SESSION_ID, sessionState } from "../features/session";
import { DEFAULT_VOLUME, SOUND_ID, soundSettings } from "../features/sound";
import type { TimedCue } from "../longBackgammon/cues";
import { GameScreen, isLongBackgammonView } from "../longBackgammon/GameScreen";
import { playCue, unlockOnGesture } from "../longBackgammon/sounds";
import { GameScreen as UtttGameScreen, isUtttView } from "../ultimateTicTacToe/GameScreen";

/**
 * Connects a game to the page: opens it while the page is up and turns clicks into ops. The game's
 * link doesn't say what game it is, so the page waits for the first snapshot, which does, and then
 * draws the board of that kind of game.
 */
export function GamePage({ gameId }: { gameId: string }) {
  const view = useQuery(gameViews.get(gameId));
  const join = useQuery(joinRequests.get(gameId));
  const rematch = useQuery(rematchRequests.get(gameId));
  const review = useQuery(reviews.get(gameId));
  const session = useQuery(sessionState.get(SESSION_ID));
  const open = useOp(openGame);
  const close = useOp(closeGame);
  const requestJoin = useOp(joinGame);
  const requestRematch = useOp(askRematch);
  const declineOffer = useOp(declineRematch);
  const startReview = useOp(openReview);
  const keepReviewOn = useOp(keepReview);
  const endReview = useOp(closeReview);
  const askAgain = useOp(retryReview);
  const showPosition = useOp(showFrame);
  const stepPosition = useOp(stepFrame);
  const select = useOp(selectPoint);
  const forfeit = useOp(forfeitGame);
  const submit = useOp(submitAction);
  const submitMove = useOp(submitMoves);
  const autoplay = useOp(setAutoplay);
  const volume = useQuery(soundSettings.get(SOUND_ID))?.volume ?? DEFAULT_VOLUME;

  // A browser lets a page make sound only after it has been used: be ready for the first press.
  useEffect(unlockOnGesture, []);

  // A game that is over, and one the user only watches, is always in review: open it for them,
  // and again when it changes (it ended, it had its first move) or the review is gone. It is cheap
  // and does nothing for a game that isn't one of those.
  const revision = view?.snapshot?.revision;
  const reviewing = review !== undefined;
  const userId = session?.userId ?? null;
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

  // What every kind of game's screen is given. A kind has more of its own: the dice, the marks.
  const common = {
    userId,
    join,
    rematchRequest: rematch,
    review,
    inviteUrl: `${location.origin}${gamePath(gameId)}`,
    onJoin: () => requestJoin({ gameId }),
    onRematch: () => requestRematch({ gameId }),
    onDeclineRematch: () => declineOffer({ gameId }),
    onReview: () => startReview({ gameId }),
    onCloseReview: () => endReview({ gameId }),
    onRetryReview: () => askAgain({ gameId }),
    onShowFrame: (index: number) => showPosition({ gameId, index }),
    onStepFrame: (by: number) => stepPosition({ gameId, by }),
    onForfeit: () => forfeit({ gameId }),
    onAutoplay: (on: boolean) => autoplay({ gameId, on }),
    // Only in development: `import.meta.env.DEV` is false in `vite build`, and the button is left out.
    showAutoplay: import.meta.env.DEV,
    onCue: (timed: TimedCue) => playCue(timed.cue, timed.afterMs, volume),
  };

  if (view && view.snapshot?.kind === ULTIMATE_TIC_TAC_TOE && isUtttView(view)) {
    return (
      <UtttGameScreen
        view={view}
        {...common}
        onPlay={(board, cell) => submit({ gameId, action: { type: "play", board, cell } })}
      />
    );
  }
  // Long backgammon, which is also what shows the page until the first snapshot says what it is.
  if (view === undefined || isLongBackgammonView(view)) {
    return (
      <GameScreen
        view={view}
        {...common}
        onRoll={() => submit({ gameId, action: { type: "roll" } })}
        onUndo={() => submit({ gameId, action: { type: "undo" } })}
        onSelect={(point) => select({ gameId, point })}
        onMove={(steps) => submitMove({ gameId, steps })}
      />
    );
  }
  return null;
}
