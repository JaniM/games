import { useOp, useQuery } from "millpond/react";
import {
  HEX,
  type HexSnapshot,
  type Seat,
  gameViews,
  hasMovesIn,
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
import { barNameOf, nameOf, rematchStage } from "../components/game/people";
import type { AnyGameViewRow } from "../components/game/rows";
import { Board } from "./Board";
import { type Colour, colourName, colourOf, frameText, resultOf, turnText, viewerSeat } from "./status";

/** A game page's row, once it is known that the game is Hex (or that there is none yet). */
export type GameViewRow = Omit<AnyGameViewRow, "snapshot"> & { snapshot: HexSnapshot | null };

/** Whether `view` is a Hex game's, so that this screen may show it. */
export function isHexView(view: AnyGameViewRow): view is GameViewRow {
  return view.snapshot === null || view.snapshot.kind === HEX;
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
  return (
    <GameShell title="Hex" shape="hex">
      {children}
    </GameShell>
  );
}

/** One Hex game, for a player or a spectator. It reads the game from the db, and what is pressed on it goes to the game's ops. */
export function GameScreen({ gameId, inviteUrl, showAutoplay }: GameScreenProps) {
  const view = useQuery(gameViews.get(gameId));
  // Who the browser is, or null while the session is being set up.
  const userId = useQuery(sessionState.get(SESSION_ID))?.userId ?? null;
  // The page is stepping through the game's positions, or is about to: undefined if it is not.
  const review = useQuery(reviews.get(gameId));
  const startReview = useOp(openReview);
  const autoplay = useOp(setAutoplay);
  const submit = useOp(submitAction);

  // The page shows this screen only for Hex.
  if (view && !isHexView(view)) return null;
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
  // Not while a move is on its way to the server: the answer is the next position.
  const canAct = myTurn && connected && !view.busy && !reviewing;
  // Blue's first turn: the swap is offered beside the cells, which are the other choice.
  const canSwap = canAct && state.canSwap;
  // The position on the board: the one picked in the review, else the game as it stands. While the
  // positions are on their way, the game as it stands is all there is to show.
  const shown = review ? shownIndex(review.frames.length, review.at) : null;
  const shownFrame = review && shown !== null ? review.frames[shown] : undefined;
  // A review holds the frames of this game, so they are all of this kind.
  const frame = shownFrame?.kind === HEX ? shownFrame : undefined;
  const board = frame?.state ?? state;
  const canReview = state !== null && hasMovesIn({ kind: snapshot.kind, state });
  // A game that is over, and one the user only watches, is always in review: there is nothing to open.
  const reviewAlways = reviewAlwaysOn(snapshot, userId);
  // Any time in a game that is on, even when it is not their turn.
  const canForfeit = mySeat !== null && state !== null && !over;
  // Offered while a game is on and its review is not always there: a player looks back when they want to.
  const canReviewMoves = canReview && !reviewAlways;
  // A player with a game going: a spectator has no turns to play.
  const canAutoplay = showAutoplay && mySeat !== null && state !== null;
  const canJoin = userId !== null && mySeat === null && !isFull(snapshot);
  const waiting = !isFull(snapshot);

  const result = resultOf(snapshot, mySeat);
  // Under the line about the turn. What has gone wrong comes before what has happened.
  const alert = !connected ? "Connection lost. Reconnecting…" : view.error;
  const aside = state ? "" : "Who plays Red and moves first is decided when the second player joins.";

  const rematch = rematchStage(snapshot, mySeat);

  // Takes the place of the status under the board, while the user steps through the game, and goes
  // above the result of a game that is over, whose rematch is still wanted. A review nobody opened,
  // of a game with no positions kept, has nothing to show.
  const nothingToStep = review?.load === "ready" && review.frames.length === 0;
  const reviewPanel =
    review && !(reviewAlways && nothingToStep) ? (
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
      {(canSwap || canReviewMoves || canForfeit || canAutoplay) && (
        <div className="status-actions">
          {canSwap && (
            <button
              className="button button-small"
              type="button"
              title="Red's stone becomes yours, on the cell across the long diagonal, and Red moves next"
              onClick={() => submit({ gameId, action: { type: "swap" } })}
            >
              Swap
            </button>
          )}
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
          {canAutoplay && (
            <button
              className="button button-quiet button-small"
              type="button"
              aria-pressed={view.auto}
              title="Plays your turns: a random empty cell, or now and then the swap"
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
    </section>
  );

  return (
    <Shell>
      {canJoin && <JoinPanel gameId={gameId} connected={connected} />}
      {mySeat !== null && waiting && <InviteBox url={inviteUrl} />}

      {/* Both players are in one row over the board, to leave the height to the board. The viewer is first. */}
      <div className="player-bars">
        <PlayerBar
          name={barNameOf(snapshot, viewer, mySeat)}
          colour={board ? colourOf(board, viewer) : null}
          toMove={board !== null && board.phase.type !== "over" && board.turn === viewer}
          empty={viewer >= snapshot.players.length}
        />
        <PlayerBar
          name={barNameOf(snapshot, opponent, mySeat)}
          colour={board ? colourOf(board, opponent) : null}
          toMove={board !== null && board.phase.type !== "over" && board.turn === opponent}
          empty={opponent >= snapshot.players.length}
        />
      </div>
      <div className="board-wrap hex-wrap">
        <Board
          gameId={gameId}
          state={board}
          revision={frame?.revision ?? snapshot.revision}
          viewer={viewer}
          interactive={canAct}
          player={mySeat !== null}
        />
      </div>

      {reviewPanel}
      {over || !reviewPanel ? status : null}
    </Shell>
  );
}

interface PlayerBarProps {
  name: string;
  /** Null before the game starts: nobody is Red yet. */
  colour: Colour | null;
  toMove: boolean;
  empty: boolean;
}

function PlayerBar({ name, colour, toMove, empty }: PlayerBarProps) {
  return (
    <div className={toMove ? "player-bar player-bar-active" : "player-bar"}>
      <span className={`swatch ${colour ? `swatch-${colour}` : "swatch-none"}`} aria-hidden="true" />
      {/* A name too long for the bar is cut off; the whole of it is in the tooltip. */}
      <span className={empty ? "player-name muted" : "player-name"} title={name}>
        {name}
      </span>
      {/* The swatch says it to the eye; its colour's name is for a screen reader. */}
      {colour && <span className="visually-hidden">{colourName(colour)}</span>}
      {/* The tint and the ring say whose turn it is to the eye; the words are for a screen reader. */}
      {toMove && <span className="visually-hidden">to move</span>}
    </div>
  );
}
