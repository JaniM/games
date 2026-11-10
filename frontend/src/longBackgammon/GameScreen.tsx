import { useOp, useQuery } from "millpond/react";
import {
  LONG_BACKGAMMON,
  type LongBackgammonSnapshot,
  type Seat,
  gameViews,
  hasMoves,
  isFull,
  openReview,
  reviewAlwaysOn,
  reviews,
  seatOf,
  setAutoplay,
  shownIndex,
  submitAction,
} from "../features/game";
import { SESSION_ID, sessionState } from "../features/session";
import { ForfeitControl } from "../components/game/ForfeitControl";
import { InviteBox } from "../components/game/InviteBox";
import { GameShell, JoinPanel, ResultSection, gameNotice } from "../components/game/Panels";
import { ReviewPanel } from "../components/game/ReviewPanel";
import type { AnyGameViewRow, JoinRequestRow, RematchRequestRow, ReviewRow } from "../components/game/rows";
import { Board } from "./Board";
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
  /** The game to show. Until the page has opened it, the screen says it is connecting. */
  gameId: string;
  /** The link to give to the opponent. It is also how anyone else can watch. */
  inviteUrl: string;
  /** Whether to offer auto-play at all. It is a development aid, so release builds leave it out. */
  showAutoplay: boolean;
}

function Shell({ children }: { children: React.ReactNode }) {
  // The nav says where you are, and the board what the game is: only a screen reader gets a title.
  return <GameShell title="Long backgammon">{children}</GameShell>;
}

/**
 * One long backgammon game, for a player or a spectator. It reads the game from the db, and
 * what is pressed on it goes to the game's ops.
 */
export function GameScreen({ gameId, inviteUrl, showAutoplay }: GameScreenProps) {
  const view = useQuery(gameViews.get(gameId));
  // Who the browser is, or null while the session is being set up.
  const userId = useQuery(sessionState.get(SESSION_ID))?.userId ?? null;
  // The page is stepping through the game's positions, or is about to: undefined if it is not.
  const review = useQuery(reviews.get(gameId));
  const submit = useOp(submitAction);
  const startReview = useOp(openReview);
  const autoplay = useOp(setAutoplay);

  // The page shows this screen only for long backgammon, or before a snapshot says what the game is.
  if (view && !isLongBackgammonView(view)) return null;
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

  // Takes the place of the status under the board, while the user steps through the game, and goes
  // above the result of a game that is over, whose rematch is still wanted. A review nobody opened,
  // of a game with no positions kept, has nothing to show.
  const nothingToStep = review?.load === "ready" && review.frames.length === 0;
  const reviewPanel = review && !(reviewAlways && nothingToStep) ? (
    <ReviewPanel
      gameId={gameId}
      text={frame ? frameText(snapshot, frame.state, mySeat) : null}
      live={over ? "" : `In the game: ${turnText(snapshot, mySeat)}`}
      closable={!reviewAlways}
    />
  ) : null;

  const status = result ? (
    <ResultSection gameId={gameId} result={result} rematch={rematch} connected={connected} />
  ) : (
    <section className="status-band" aria-label="Turn" data-turn={myTurn ? "mine" : "wait"}>
      {(canReviewMoves || canForfeit || (showAutoplay && mySeat !== null && state)) && (
        <div className="status-actions">
          {canReviewMoves && (
            <button
              className="button button-quiet button-small"
              type="button"
              onClick={() => startReview({ gameId })}
            >
              Review moves
            </button>
          )}
          {canForfeit && (
            <ForfeitControl
              gameId={gameId}
              opponent={nameOf(snapshot, opponent, mySeat)}
              disabled={!connected || view.busy}
            />
          )}
          {showAutoplay && mySeat !== null && state && (
            <button
              className="button button-quiet button-small"
              type="button"
              aria-pressed={view.auto}
              title="Plays your turns: a checker off the head when it can, otherwise a random legal move"
              onClick={() => autoplay({ gameId, on: !view.auto })}
            >
              Auto-play
            </button>
          )}
        </div>
      )}
      <p className="status-main" role="status" aria-live="polite">
        {turnText(snapshot, mySeat)}
      </p>
      {(alert || aside) && (
        <p className={alert ? "status-detail status-detail-alert" : "status-detail"}>
          {alert ? <span role="alert">{alert}</span> : aside}
        </p>
      )}
      {lastThrow && <p className="status-warning">{lastThrow}</p>}
    </section>
  );

  return (
    <Shell>
      {canJoin && <JoinPanel gameId={gameId} connected={connected} />}
      {mySeat !== null && waiting && <InviteBox url={inviteUrl} />}

      {/* Both players are in one row over the board, to leave the height to the board. The viewer is
          first: the board is turned to put their head in the top right corner. */}
      <div className="player-bars">
        <PlayerBar
          name={barNameOf(snapshot, viewer, mySeat)}
          colour={board ? colourOf(viewer, board, viewer) : null}
          toMove={board !== null && board.phase.type !== "over" && board.turn === viewer}
          empty={viewer >= snapshot.players.length}
        />
        <PlayerBar
          name={barNameOf(snapshot, opponent, mySeat)}
          colour={board ? colourOf(opponent, board, viewer) : null}
          toMove={board !== null && board.phase.type !== "over" && board.turn === opponent}
          empty={opponent >= snapshot.players.length}
        />
      </div>
      <div className="board-wrap">
        <Board
          gameId={gameId}
          state={board}
          revision={frame?.revision ?? snapshot.revision}
          viewer={viewer}
          selected={reviewing ? null : view.selected}
          interactive={canAct}
          player={mySeat !== null}
        />
        {/* Roll goes under the dice: nothing can be moved until they are thrown. Undo is there
            while checkers are being moved, so it goes between the trays, where it covers no stack. */}
        {canAct && state?.phase.type === "roll" && (
          <button
            className="button under-dice"
            type="button"
            style={underDiceSpot()}
            onClick={() => submit({ gameId, action: { type: "roll" } })}
          >
            Roll dice
          </button>
        )}
        {canUndo && (
          <button
            className="button button-quiet between-trays"
            type="button"
            style={betweenTraysSpot()}
            onClick={() => submit({ gameId, action: { type: "undo" } })}
          >
            Undo
          </button>
        )}
      </div>

      {reviewPanel}
      {over || !reviewPanel ? status : null}
    </Shell>
  );
}

interface PlayerBarProps {
  name: string;
  /** Null before the game starts: nobody is White yet. */
  colour: Colour | null;
  toMove: boolean;
  empty: boolean;
}

function PlayerBar({ name, colour, toMove, empty }: PlayerBarProps) {
  return (
    <div className={toMove ? "player-bar player-bar-active" : "player-bar"}>
      <span className={`swatch swatch-${colour ?? "none"}`} aria-hidden="true" />
      {/* A name too long for the bar is cut off; the whole of it is in the tooltip. */}
      <span className={empty ? "player-name muted" : "player-name"} title={name}>
        {name}
      </span>
      {/* The swatch says it to the eye; the name of the colour is for a screen reader. */}
      {colour && <span className="visually-hidden">{colour === "white" ? "White" : "Black"}</span>}
      {/* The tint and the ring say whose turn it is to the eye; the words are for a screen reader. */}
      {toMove && <span className="visually-hidden">to move</span>}
    </div>
  );
}
