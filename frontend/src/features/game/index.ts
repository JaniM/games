import { feature } from "millpond";
import { autoPlay, connectGame, joinGameRequest, sendActions } from "./effects";
import {
  actionDropped,
  actionRefused,
  actionSent,
  closeGame,
  connectionChanged,
  gameProblem,
  joinFailed,
  joinGame,
  joined,
  openGame,
  selectPoint,
  setAutoplay,
  snapshotReceived,
  submitAction,
} from "./ops";
import { gameActions, gameViews, joinRequests } from "./tables";

export const game = feature({
  tables: { gameViews, gameActions, joinRequests },
  ops: {
    openGame,
    closeGame,
    connectionChanged,
    snapshotReceived,
    gameProblem,
    actionRefused,
    selectPoint,
    setAutoplay,
    submitAction,
    actionSent,
    actionDropped,
    joinGame,
    joined,
    joinFailed,
  },
  effects: { connectGame, sendActions, joinGameRequest, autoPlay },
});

// Components import definitions by value; they never need the assembled db.
export { closeGame, joinGame, openGame, selectPoint, setAutoplay, submitAction } from "./ops";
export { isFull, landing, seatOf } from "./selectors";
export type { Landing } from "./selectors";
export type {
  Action,
  LongBackgammonState,
  Phase,
  Seat,
  Snapshot,
  Step,
} from "./schemas";
export { gameActions, gameViews, joinRequests } from "./tables";
