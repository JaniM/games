import { useOp, useQuery } from "millpond/react";
import { useEffect } from "react";
import {
  closeGame,
  gameViews,
  joinGame,
  joinRequests,
  openGame,
  selectPoint,
  submitAction,
} from "../features/game";
import { gamePath } from "../features/router";
import { SESSION_ID, sessionState } from "../features/session";
import { GameScreen } from "../longBackgammon/GameScreen";

const KIND = "long-backgammon";

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
      inviteUrl={`${location.origin}${gamePath(KIND, gameId)}`}
      onJoin={() => requestJoin({ gameId })}
      onRoll={() => submit({ gameId, action: { type: "roll" } })}
      onSelect={(point) => select({ gameId, point })}
      onMove={(step) => submit({ gameId, action: { type: "move", from: step.from, die: step.die } })}
    />
  );
}
