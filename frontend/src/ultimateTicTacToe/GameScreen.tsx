import {
  type Seat,
  type UtttSnapshot,
  ULTIMATE_TIC_TAC_TOE,
  hasMovesIn,
  isFull,
  reviewAlwaysOn,
  seatOf,
  shownIndex,
} from "../features/game";
import { ForfeitControl } from "../components/game/ForfeitControl";
import { InviteBox } from "../components/game/InviteBox";
import { GameShell, JoinPanel, ResultSection, gameNotice } from "../components/game/Panels";
import { ReviewPanel } from "../components/game/ReviewPanel";
import { barNameOf, nameOf, rematchStage } from "../components/game/people";
import type { AnyGameViewRow, JoinRequestRow, RematchRequestRow, ReviewRow } from "../components/game/rows";
import type { TimedCue } from "../longBackgammon/cues";
import { Board } from "./Board";
import { MarkIcon } from "./Mark";
import {
  type Mark,
  frameText,
  markName,
  markOf,
  resultOf,
  turnText,
  viewerSeat,
} from "./status";

/** A game page's row, once it is known that the game is ultimate tic-tac-toe (or that there is none yet). */
export type GameViewRow = Omit<AnyGameViewRow, "snapshot"> & { snapshot: UtttSnapshot | null };

/** Whether `view` is an ultimate tic-tac-toe game's, so that this screen may show it. */
export function isUtttView(view: AnyGameViewRow): view is GameViewRow {
  return view.snapshot === null || view.snapshot.kind === ULTIMATE_TIC_TAC_TOE;
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
  /** Gives up the game. The screen asks the player to confirm first. */
  onForfeit: () => void;
  /** Turns auto-play (this player's turns, played for them) on or off. */
  onAutoplay: (on: boolean) => void;
  /** Whether to offer auto-play at all. It is a development aid, so release builds leave it out. */
  showAutoplay: boolean;
  /** Marks a cell. A mark is final: there is no taking it back. */
  onPlay: (board: number, cell: number) => void;
  /** Plays a sound. The caller applies the volume, and may play nothing. */
  onCue: (cue: TimedCue) => void;
}

function Shell({ children }: { children: React.ReactNode }) {
  // The nav says where you are, and the board what the game is: only a screen reader gets a title.
  return (
    <GameShell title="Ultimate tic-tac-toe" shape="square">
      {children}
    </GameShell>
  );
}

/**
 * One ultimate tic-tac-toe game, for a player or a spectator. Everything it shows comes
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
  onForfeit,
  onAutoplay,
  showAutoplay,
  onPlay,
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
  // Not while a mark is on its way to the server: the answer is the next position.
  const canAct = myTurn && connected && !view.busy && !reviewing;
  // The position on the board: the one picked in the review, else the game as it stands. While the
  // positions are on their way, the game as it stands is all there is to show.
  const shown = review ? shownIndex(review.frames.length, review.at) : null;
  const shownFrame = review && shown !== null ? review.frames[shown] : undefined;
  // A review holds the frames of this game, so they are all of this kind.
  const frame = shownFrame?.kind === ULTIMATE_TIC_TAC_TOE ? shownFrame : undefined;
  const board = frame?.state ?? state;
  const canReview = state !== null && hasMovesIn({ kind: snapshot.kind, state });
  // A game that is over, and one the user only watches, is always in review: there is nothing to open.
  const reviewAlways = reviewAlwaysOn(snapshot, userId);
  // Any time in a game that is on, even when it is not their turn.
  const canForfeit = mySeat !== null && state !== null && !over;
  // Offered while a game is on and its review is not always there: a player looks back when they want to.
  const canReviewMoves = canReview && !reviewAlways;
  // A player with a game going, as in long backgammon: a spectator has no turns to play.
  const canAutoplay = showAutoplay && mySeat !== null && state !== null;
  const canJoin = userId !== null && mySeat === null && !isFull(snapshot);
  const waiting = !isFull(snapshot);

  const result = resultOf(snapshot, mySeat);
  // Under the line about the turn. What has gone wrong comes before what has happened.
  const alert = !connected ? "Connection lost. Reconnecting…" : view.error;
  const aside = state ? "" : "Who plays X and moves first is decided when the second player joins.";

  const rematch = rematchStage(snapshot, mySeat);
  // A player's own rematch answer has gone out and the other's is not back. It shows as a snapshot.
  const answering = rematchRequest?.state === "sending";
  const rematchProblem = rematchRequest?.state === "failed" ? rematchRequest.error : null;

  // Takes the place of the status under the board, while the user steps through the game, and goes
  // above the result of a game that is over, whose rematch is still wanted. A review nobody opened,
  // of a game with no positions kept, has nothing to show.
  const nothingToStep = review?.load === "ready" && review.frames.length === 0;
  const reviewPanel =
    review && !(reviewAlways && nothingToStep) ? (
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
      {(canReviewMoves || canForfeit || canAutoplay) && (
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
          {canAutoplay && (
            <button
              className="button button-quiet button-small"
              type="button"
              aria-pressed={view.auto}
              title="Plays your turns: a random empty cell in a board you may play in"
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

      {/* Both players are in one row over the board, to leave the height to the board. The viewer is first. */}
      <div className="player-bars">
        <PlayerBar
          name={barNameOf(snapshot, viewer, mySeat)}
          mark={board ? markOf(board, viewer) : null}
          toMove={board !== null && board.phase.type !== "over" && board.turn === viewer}
          empty={viewer >= snapshot.players.length}
        />
        <PlayerBar
          name={barNameOf(snapshot, opponent, mySeat)}
          mark={board ? markOf(board, opponent) : null}
          toMove={board !== null && board.phase.type !== "over" && board.turn === opponent}
          empty={opponent >= snapshot.players.length}
        />
      </div>
      <div className="board-wrap ttt-wrap">
        <Board
          state={board}
          revision={frame?.revision ?? snapshot.revision}
          viewer={viewer}
          interactive={canAct}
          player={mySeat !== null}
          onPlay={onPlay}
          onCue={onCue}
        />
      </div>

      {reviewPanel}
      {over || !reviewPanel ? status : null}
    </Shell>
  );
}

interface PlayerBarProps {
  name: string;
  /** Null before the game starts: nobody is X yet. */
  mark: Mark | null;
  toMove: boolean;
  empty: boolean;
}

function PlayerBar({ name, mark, toMove, empty }: PlayerBarProps) {
  return (
    <div className={toMove ? "player-bar player-bar-active" : "player-bar"}>
      <span className={`player-mark${mark ? "" : " player-mark-none"}`} aria-hidden="true">
        {mark && <MarkIcon mark={mark} />}
      </span>
      {/* A name too long for the bar is cut off; the whole of it is in the tooltip. */}
      <span className={empty ? "player-name muted" : "player-name"} title={name}>
        {name}
      </span>
      {/* The mark says it to the eye; its name is for a screen reader. */}
      {mark && <span className="visually-hidden">{markName(mark)}</span>}
      {/* The tint and the ring say whose turn it is to the eye; the words are for a screen reader. */}
      {toMove && <span className="visually-hidden">to move</span>}
    </div>
  );
}
