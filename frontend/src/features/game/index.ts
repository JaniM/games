import { feature } from "millpond";
import {
  autoPlay,
  connectGame,
  continueMoves,
  followRematch,
  joinGameRequest,
  rematchRequest,
  sendActions,
} from "./effects";
import {
  actionDropped,
  actionRefused,
  actionSent,
  askRematch,
  closeGame,
  connectionChanged,
  declineRematch,
  gameProblem,
  joinFailed,
  joinGame,
  joined,
  openGame,
  rematchFailed,
  rematchSent,
  selectPoint,
  sendQueued,
  setAutoplay,
  snapshotReceived,
  submitAction,
  submitMoves,
} from "./ops";
import { gameActions, gameViews, joinRequests, rematchRequests } from "./tables";

export const game = feature({
  tables: { gameViews, gameActions, joinRequests, rematchRequests },
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
    submitMoves,
    sendQueued,
    actionSent,
    actionDropped,
    joinGame,
    joined,
    joinFailed,
    askRematch,
    declineRematch,
    rematchSent,
    rematchFailed,
  },
  effects: {
    connectGame,
    sendActions,
    joinGameRequest,
    autoPlay,
    continueMoves,
    rematchRequest,
    followRematch,
  },
});

// Components import definitions by value; they never need the assembled db.
export {
  askRematch,
  closeGame,
  declineRematch,
  joinGame,
  openGame,
  selectPoint,
  setAutoplay,
  submitAction,
  submitMoves,
} from "./ops";
export { isFull, landing, seatOf } from "./selectors";
export type { Landing } from "./selectors";
export type {
  Action,
  LongBackgammonState,
  Phase,
  Rematch,
  Seat,
  Snapshot,
  Step,
} from "./schemas";
export { gameActions, gameViews, joinRequests, rematchRequests } from "./tables";
