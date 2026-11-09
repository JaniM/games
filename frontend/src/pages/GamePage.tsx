import { useOp, useQuery } from "millpond/react";
import { useEffect } from "react";
import {
  closeGame,
  gameViews,
  joinGame,
  joinRequests,
  openGame,
  selectPoint,
  setAutoplay,
  submitAction,
  submitMoves,
} from "../features/game";
import { gamePath } from "../features/router";
import { SESSION_ID, sessionState } from "../features/session";
import { DEFAULT_VOLUME, SOUND_ID, setVolume, soundSettings } from "../features/sound";
import type { TimedCue } from "../longBackgammon/cues";
import { GameScreen } from "../longBackgammon/GameScreen";
import { playCue, unlockOnGesture } from "../longBackgammon/sounds";

/** Connects a long backgammon game to the page: opens it while the page is up and turns clicks into ops. */
export function GamePage({ gameId }: { gameId: string }) {
  const view = useQuery(gameViews.get(gameId));
  const join = useQuery(joinRequests.get(gameId));
  const session = useQuery(sessionState.get(SESSION_ID));
  const open = useOp(openGame);
  const close = useOp(closeGame);
  const requestJoin = useOp(joinGame);
  const select = useOp(selectPoint);
  const submit = useOp(submitAction);
  const submitMove = useOp(submitMoves);
  const autoplay = useOp(setAutoplay);
  const volume = useQuery(soundSettings.get(SOUND_ID))?.volume ?? DEFAULT_VOLUME;
  const changeVolume = useOp(setVolume);

  // A browser lets a page make sound only after it has been used: be ready for the first press.
  useEffect(unlockOnGesture, []);

  // Open the game while this page shows it, and close it (and its socket) on the way out.
  // `useOp` gives the same function until the db changes, so this runs once per game id.
  useEffect(() => {
    open({ gameId });
    return () => close({ gameId });
  }, [gameId, open, close]);

  return (
    <GameScreen
      view={view}
      userId={session?.userId ?? null}
      join={join}
      inviteUrl={`${location.origin}${gamePath(gameId)}`}
      onJoin={() => requestJoin({ gameId })}
      onRoll={() => submit({ gameId, action: { type: "roll" } })}
      onUndo={() => submit({ gameId, action: { type: "undo" } })}
      onAutoplay={(on) => autoplay({ gameId, on })}
      // Only in development: `import.meta.env.DEV` is false in `vite build`, and the button is left out.
      showAutoplay={import.meta.env.DEV}
      onSelect={(point) => select({ gameId, point })}
      onMove={(steps) => submitMove({ gameId, steps })}
      volume={volume}
      onVolume={(level) => changeVolume({ volume: level })}
      onCue={(timed: TimedCue) => playCue(timed.cue, timed.afterMs, volume)}
    />
  );
}
