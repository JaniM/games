import {
  LONG_BACKGAMMON,
  type LongBackgammonSnapshot,
  type Seat,
  type Step,
  hasMoves,
  hasMovesIn,
  isFull,
  reviewAlwaysOn,
  seatOf,
  shownIndex,
} from "../features/game";
import { ForfeitControl } from "../gameUi/ForfeitControl";
import { InviteBox } from "../gameUi/InviteBox";
import { GameShell, JoinPanel, ResultSection, gameNotice } from "../gameUi/Panels";
import { ReviewPanel } from "../gameUi/ReviewPanel";
import type { AnyGameViewRow, JoinRequestRow, RematchRequestRow, ReviewRow } from "../gameUi/rows";
import { Board } from "./Board";
import type { TimedCue } from "./cues";
import { betweenTraysSpot, underDiceSpot } from "./geometry";
import { type Colour, colourOf } from "./layout";
import {
  barNameOf,
  frameText,
  lastThrowText,
  nameOf,
  rematchStage,
  resultOf,
  turnText,
  viewerSeat,
} from "./status";

export type { JoinRequestRow, RematchRequestRow, ReviewRow };

/** A game page's row, once it is known that the game is long backgammon (or that there is none yet). */
export type GameViewRow = Omit<AnyGameViewRow, "snapshot"> & { snapshot: LongBackgammonSnapshot | null };

/** Whether `view` is a long backgammon game's, so that this screen may show it. */
export function isLongBackgammonView(view: AnyGameViewRow): view is GameViewRow {
  return view.snapshot === null || view.snapshot.kind === LONG_BACKGAMMON;
}

export interface GameScreenProps {
  /** The game page's row, or undefined for the moment before the page has opened it. */
  view: GameViewRow | undefined;
  /** Who the browser is, or null while the session is being set up. */
  userId: string | null;
  join: JoinRequestRow | undefined;
  /** An answer about the rematch that is on its way, or has failed; undefined if there is none. */
  rematchRequest: RematchRequestRow | undefined;
  /** The page is stepping through the game's positions, or is about to: undefined if it is not. */
  review: ReviewRow | undefined;
  /** The link to give to the opponent. It is also how anyone else can watch. */
  inviteUrl: string;
  onJoin: () => void;
  /** Asks for a rematch of the finished game, or says yes to the other player's ask. */
  onRematch: () => void;
  /** Takes back one's own ask for a rematch, or says no to the other player's. */
  onDeclineRematch: () => void;
  /** Starts stepping through the game's positions. */
  onReview: () => void;
  onCloseReview: () => void;
  /** Asks again for the positions, after that failed. */
  onRetryReview: () => void;
  /** Shows the position at this index of the review. */
  onShowFrame: (index: number) => void;
  /** Shows the position this many places on in the review: 1 for the next, -1 for the one before. */
  onStepFrame: (by: number) => void;
  onRoll: () => void;
  /** Takes back the last step of the turn in progress. */
  onUndo: () => void;
  /** Gives up the game. The screen asks the player to confirm first. */
  onForfeit: () => void;
  /** Turns auto-play (this player's turns, played for them) on or off. */
  onAutoplay: (on: boolean) => void;
  /** Whether to offer auto-play at all. It is a development aid, so release builds leave it out. */
  showAutoplay: boolean;
  onSelect: (point: number | null) => void;
  /** Plays steps one after the other: one for a single die, more for a combined move by one checker. */
  onMove: (steps: Step[]) => void;
  /** Plays a sound. The caller applies the volume, and may play nothing. */
  onCue: (cue: TimedCue) => void;
}

function Shell({ children }: { children: React.ReactNode }) {
  // The nav says where you are, and the board what the game is: only a screen reader gets a title.
  return <GameShell title="Long backgammon">{children}</GameShell>;
}

/**
 * One long backgammon game, for a player or a spectator. Everything it shows comes
 * from its props, so it can be rendered without a db.
 */
export function GameScreen({
  view,
  userId,
  join,
  rematchRequest,
  review,
  inviteUrl,
  onJoin,
  onRematch,
  onDeclineRematch,
  onReview,
  onCloseReview,
  onRetryReview,
  onShowFrame,
  onStepFrame,
  onRoll,
  onUndo,
  onForfeit,
  onAutoplay,
  showAutoplay,
  onSelect,
  onMove,
  onCue,
}: GameScreenProps) {
  const notice = gameNotice(view);
  if (notice) return notice;
  const snapshot = view?.snapshot;
  // The notice has said what there is to say when there is no snapshot: this is for the types.
  if (!view || !snapshot) return null;

  const state = snapshot.state;
  const mySeat = seatOf(snapshot, userId);
  const viewer = viewerSeat(mySeat, state);
  const opponent = (1 - viewer) as Seat;
  const connected = view.connection === "open";
  const over = state?.phase.type === "over";
  const myTurn = state !== null && mySeat !== null && state.turn === mySeat && !over;
  // In a review the board shows a position of the past, which nothing can be played in.
  const reviewing = review !== undefined;
  // Not while a step is on its way, nor between the steps of a combined move: it is one move.
  const canAct = myTurn && connected && !view.busy && view.queued.length === 0 && !reviewing;
  // The position on the board: the one picked in the review, else the game as it stands. While the
  // positions are on their way, the game as it stands is all there is to show.
  const shown = review ? shownIndex(review.frames.length, review.at) : null;
  const shownFrame = review && shown !== null ? review.frames[shown] : undefined;
  // A review holds the frames of this game, so they are all of this kind.
  const frame = shownFrame?.kind === LONG_BACKGAMMON ? shownFrame : undefined;
  const board = frame?.state ?? state;
  const canReview = state !== null && hasMoves(state);
  // A game that is over, and one the user only watches, is always in review: there is nothing to open.
  const reviewAlways = reviewAlwaysOn(snapshot, userId);
  // Only a step of the turn in progress can be taken back: the one that ends the turn is final.
  const canUndo = canAct && state?.phase.type === "move" && state.phase.played.length > 0;
  // Any time in a game that is on, even when it is not their turn.
  const canForfeit = mySeat !== null && state !== null && !over;
  // Offered while a game is on and its review is not always there: a player looks back when they want to.
  const canReviewMoves = canReview && !reviewAlways;
  const canJoin = userId !== null && mySeat === null && !isFull(snapshot);
  const waiting = !isFull(snapshot);

  const lastThrow = state ? lastThrowText(state) : "";
  const result = resultOf(snapshot, mySeat);
  // Under the line about the turn. What has gone wrong comes before what has happened.
  const alert = !connected ? "Connection lost. Reconnecting…" : view.error;
  const aside = state ? "" : "Who plays White and moves first is decided when the second player joins.";

  const rematch = rematchStage(snapshot, mySeat);
  // A player's own rematch answer has gone out and the other's is not back. It shows as a snapshot.
  const answering = rematchRequest?.state === "sending";
  const rematchProblem = rematchRequest?.state === "failed" ? rematchRequest.error : null;

  // Takes the place of the status under the board, while the user steps through the game, and goes
  // above the result of a game that is over, whose rematch is still wanted. A review nobody opened,
  // of a game with no positions kept, has nothing to show.
  const nothingToStep = review?.load === "ready" && review.frames.length === 0;
  const reviewPanel = review && !(reviewAlways && nothingToStep) ? (
    <ReviewPanel
      loading={review.load === "loading"}
      error={review.load === "failed" ? review.error : null}
      count={review.frames.length}
      index={shown}
      text={frame ? frameText(snapshot, frame.state, mySeat) : null}
      partial={review.frames[0] !== undefined && hasMovesIn(review.frames[0])}
      live={over ? "" : `In the game: ${turnText(snapshot, mySeat)}`}
      onShow={onShowFrame}
      onStep={onStepFrame}
      onRetry={onRetryReview}
      onClose={reviewAlways ? null : onCloseReview}
    />
  ) : null;

  const status = result ? (
    <ResultSection
      result={result}
      rematch={rematch}
      connected={connected}
      answering={answering}
      rematchProblem={rematchProblem}
      onRematch={onRematch}
      onDeclineRematch={onDeclineRematch}
    />
  ) : (
    <section className="status-band" aria-label="Turn" data-turn={myTurn ? "mine" : "wait"}>
      <p className="status-main" role="status" aria-live="polite">
        {turnText(snapshot, mySeat)}
      </p>
      {(alert || aside) && (
        <p className={alert ? "status-detail status-detail-alert" : "status-detail"}>
          {alert ? <span role="alert">{alert}</span> : aside}
        </p>
      )}
      {lastThrow && <p className="status-warning">{lastThrow}</p>}
      {(canReviewMoves || canForfeit || (showAutoplay && mySeat !== null && state)) && (
        <div className="status-actions">
          {canReviewMoves && (
            <button className="button button-quiet button-small" type="button" onClick={onReview}>
              Review moves
            </button>
          )}
          {canForfeit && (
            <ForfeitControl
              opponent={nameOf(snapshot, opponent, mySeat)}
              disabled={!connected || view.busy}
              onForfeit={onForfeit}
            />
          )}
          {showAutoplay && mySeat !== null && state && (
            <button
              className="button button-quiet button-small"
              type="button"
              aria-pressed={view.auto}
              title="Plays your turns: a checker off the head when it can, otherwise a random legal move"
              onClick={() => onAutoplay(!view.auto)}
            >
              Auto-play
            </button>
          )}
        </div>
      )}
    </section>
  );

  return (
    <Shell>
      {canJoin && <JoinPanel connected={connected} join={join} onJoin={onJoin} />}
      {mySeat !== null && waiting && <InviteBox url={inviteUrl} />}

      {/* The viewer is on top: the board is turned to put their head in the top right corner. */}
      <PlayerBar
        edge="above"
        name={barNameOf(snapshot, viewer, mySeat)}
        colour={board ? colourOf(viewer, board, viewer) : null}
        off={board?.off[viewer] ?? 0}
        toMove={board !== null && board.phase.type !== "over" && board.turn === viewer}
        empty={viewer >= snapshot.players.length}
      />
      <div className="board-wrap">
        <Board
          state={board}
          revision={frame?.revision ?? snapshot.revision}
          viewer={viewer}
          selected={reviewing ? null : view.selected}
          interactive={canAct}
          player={mySeat !== null}
          onSelect={onSelect}
          onMove={onMove}
          onCue={onCue}
        />
        {/* Roll goes under the dice: nothing can be moved until they are thrown. Undo is there
            while checkers are being moved, so it goes between the trays, where it covers no stack. */}
        {canAct && state?.phase.type === "roll" && (
          <button className="button under-dice" type="button" style={underDiceSpot()} onClick={onRoll}>
            Roll dice
          </button>
        )}
        {canUndo && (
          <button
            className="button button-quiet between-trays"
            type="button"
            style={betweenTraysSpot()}
            onClick={onUndo}
          >
            Undo
          </button>
        )}
      </div>
      <PlayerBar
        edge="below"
        name={barNameOf(snapshot, opponent, mySeat)}
        colour={board ? colourOf(opponent, board, viewer) : null}
        off={board?.off[opponent] ?? 0}
        toMove={board !== null && board.phase.type !== "over" && board.turn === opponent}
        empty={opponent >= snapshot.players.length}
      />

      {reviewPanel}
      {over || !reviewPanel ? status : null}
    </Shell>
  );
}

interface PlayerBarProps {
  /** Where the bar is: over the board or under it. The highlight is on the edge toward the board. */
  edge: "above" | "below";
  name: string;
  /** Null before the game starts: nobody is White yet. */
  colour: Colour | null;
  off: number;
  toMove: boolean;
  empty: boolean;
}

function PlayerBar({ edge, name, colour, off, toMove, empty }: PlayerBarProps) {
  return (
    <div className={`player-bar player-bar-${edge}${toMove ? " player-bar-active" : ""}`}>
      <span className={`swatch swatch-${colour ?? "none"}`} aria-hidden="true" />
      <span className={empty ? "player-name muted" : "player-name"}>{name}</span>
      {/* The swatch says it to the eye; the name of the colour is for a screen reader. */}
      {colour && <span className="visually-hidden">{colour === "white" ? "White" : "Black"}</span>}
      {toMove && <span className="player-turn">to move</span>}
      {off > 0 && <span className="player-off">{off} borne off</span>}
    </div>
  );
}
