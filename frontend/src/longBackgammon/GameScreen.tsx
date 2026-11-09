import type { RowOf } from "millpond";
import { useRef, useState } from "react";
import { Link } from "../Link";
import { OptionsMenu } from "../OptionsMenu";
import { copyText } from "../copyText";
import {
  type Seat,
  type Step,
  type gameViews,
  type joinRequests,
  type rematchRequests,
  type reviews,
  hasMoves,
  isFull,
  seatOf,
  shownIndex,
} from "../features/game";
import { gamePath } from "../features/router";
import { Board } from "./Board";
import type { TimedCue } from "./cues";
import { betweenTraysSpot, underDiceSpot } from "./geometry";
import { type Colour, colourOf } from "./layout";
import { ReviewPanel } from "./ReviewPanel";
import {
  barNameOf,
  frameText,
  lastThrowText,
  rematchStage,
  resultOf,
  turnText,
  viewerSeat,
} from "./status";
import { VolumeControl } from "./VolumeControl";

export type GameViewRow = RowOf<typeof gameViews>;
export type JoinRequestRow = RowOf<typeof joinRequests>;
export type RematchRequestRow = RowOf<typeof rematchRequests>;
export type ReviewRow = RowOf<typeof reviews>;

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
  /** Turns auto-play (this player's turns, played for them) on or off. */
  onAutoplay: (on: boolean) => void;
  /** Whether to offer auto-play at all. It is a development aid, so release builds leave it out. */
  showAutoplay: boolean;
  onSelect: (point: number | null) => void;
  /** Plays steps one after the other: one for a single die, more for a combined move by one checker. */
  onMove: (steps: Step[]) => void;
  /** How loud the sounds are, from 0 (silent) to 1. */
  volume: number;
  onVolume: (volume: number) => void;
  /** Plays a sound. The caller applies the volume, and may play nothing. */
  onCue: (cue: TimedCue) => void;
}

const HOME = "/";

interface ShellProps {
  options?: React.ReactNode;
  /** What the viewer is to the game, beside its title, if they are not a player. */
  caption?: string;
  children: React.ReactNode;
}

function Shell({ options, caption, children }: ShellProps) {
  return (
    <main className="page game-page">
      <div className="game-top">
        <p className="crumbs">
          <Link to={HOME}>← All games</Link>
        </p>
        {options}
      </div>
      <header className="game-head">
        <h1 className="game-title">Long backgammon</h1>
        {caption && <p className="game-caption">{caption}</p>}
      </header>
      {children}
    </main>
  );
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
  onAutoplay,
  showAutoplay,
  onSelect,
  onMove,
  volume,
  onVolume,
  onCue,
}: GameScreenProps) {
  if (view?.connection === "missing") {
    return (
      <Shell>
        <p role="alert">There is no game at this link. Check the link, or start a new game.</p>
      </Shell>
    );
  }
  if (view?.problem) {
    return (
      <Shell>
        <p role="alert">{view.problem}</p>
      </Shell>
    );
  }
  const snapshot = view?.snapshot;
  if (!view || !snapshot) {
    return (
      <Shell>
        <p role="status">Connecting to the game…</p>
      </Shell>
    );
  }

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
  const frame = review && shown !== null ? review.frames[shown] : undefined;
  const board = frame?.state ?? state;
  const canReview = state !== null && hasMoves(state);
  // Only a step of the turn in progress can be taken back: the one that ends the turn is final.
  const canUndo = canAct && state?.phase.type === "move" && state.phase.played.length > 0;
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

  // Takes the place of the status or the result under the board, while the user steps through the game.
  const reviewPanel = review ? (
    <ReviewPanel
      loading={review.load === "loading"}
      error={review.load === "failed" ? review.error : null}
      count={review.frames.length}
      index={shown}
      text={frame ? frameText(snapshot, frame.state, mySeat) : null}
      partial={review.frames[0] !== undefined && hasMoves(review.frames[0].state)}
      live={over ? "" : `In the game: ${turnText(snapshot, mySeat)}`}
      onShow={onShowFrame}
      onStep={onStepFrame}
      onRetry={onRetryReview}
      onClose={onCloseReview}
    />
  ) : null;

  const status = result ? (
    <section className={result.won ? "result result-won" : "result"} aria-label="Result">
      <div>
        <p className="result-kicker">Game over</p>
        <p className="result-title" role="status">
          {result.title}
        </p>
        {result.detail && <p className="result-detail">{result.detail}</p>}
        {/* Always there, so that a screen reader hears it when the other player answers. */}
        <p
          className={rematch.stage === "answer" ? "result-rematch result-rematch-due" : "result-rematch"}
          role="status"
        >
          {rematch.line}
        </p>
        {rematchProblem && (
          <p className="result-rematch result-rematch-due" role="alert">
            {rematchProblem}
          </p>
        )}
      </div>
      <div className="result-actions">
        {rematch.stage === "ask" && (
          <button className="button" type="button" disabled={!connected || answering} onClick={onRematch}>
            Rematch
          </button>
        )}
        {rematch.stage === "answer" && (
          <>
            <button className="button" type="button" disabled={!connected || answering} onClick={onRematch}>
              Accept
            </button>
            <button
              className="button button-quiet"
              type="button"
              disabled={!connected || answering}
              onClick={onDeclineRematch}
            >
              Decline
            </button>
          </>
        )}
        {rematch.stage === "waiting" && (
          <button
            className="button button-quiet"
            type="button"
            disabled={!connected || answering}
            onClick={onDeclineRematch}
          >
            Cancel
          </button>
        )}
        {rematch.stage === "started" && (
          <Link className="button" to={gamePath(rematch.gameId)}>
            Go to the rematch
          </Link>
        )}
        <button className="button button-quiet" type="button" onClick={onReview}>
          Review game
        </button>
        {/* The way out is the main button only when there is nothing else to do. */}
        <Link className={rematch.stage === "closed" ? "button" : "button button-quiet"} to={HOME}>
          All games
        </Link>
      </div>
    </section>
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
      {(canReview || (showAutoplay && mySeat !== null && state)) && (
        <div className="status-actions">
          {canReview && (
            <button className="button button-quiet button-small" type="button" onClick={onReview}>
              Review moves
            </button>
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
    <Shell
      caption={mySeat === null && userId !== null && !canJoin ? "You are watching this game." : undefined}
      options={
        <OptionsMenu>
          {/* Letting go of the slider plays a knock, so that the new level can be heard. */}
          <VolumeControl
            volume={volume}
            onChange={onVolume}
            onSettle={() => onCue({ cue: "move", afterMs: 0 })}
          />
        </OptionsMenu>
      }
    >
      {canJoin && (
        <section className="panel" aria-label="Join this game">
          <p>This game is waiting for a second player.</p>
          <button className="button" type="button" disabled={!connected || join?.state === "joining"} onClick={onJoin}>
            {join?.state === "joining" ? "Joining…" : "Join game"}
          </button>
          {join?.state === "failed" && (
            <p className="error" role="alert">
              {`Could not join: ${join.error}`}
            </p>
          )}
          <p className="muted">Or just watch: anyone with this link can.</p>
        </section>
      )}
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

      {reviewPanel ?? status}
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
      {colour && <span className="player-colour">{colour === "white" ? "White" : "Black"}</span>}
      {toMove && <span className="player-turn">to move</span>}
      {off > 0 && <span className="player-off">{off} borne off</span>}
    </div>
  );
}

/** The link to share, with a way to copy it. */
function InviteBox({ url }: { url: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<"yes" | "manual" | null>(null);

  async function copy() {
    if (await copyText(url)) {
      setCopied("yes");
      return;
    }
    // Neither way of copying worked (or the person said no): select the link for them.
    if (input.current) selectAll(input.current);
    setCopied("manual");
  }

  return (
    <section className="panel" aria-label="Invite">
      <p>Send this link to the person you want to play with. Anyone who opens it can also watch.</p>
      <div className="invite">
        <input
          ref={input}
          className="invite-url"
          readOnly
          value={url}
          aria-label="Game link"
          onFocus={(event) => selectAll(event.currentTarget)}
        />
        <button className="button" type="button" onClick={copy}>
          Copy link
        </button>
      </div>
      <p className="muted" role="status">
        {copied === "yes" ? "Link copied." : copied === "manual" ? manualCopyHint() : ""}
      </p>
    </section>
  );
}

/** Selects all of a field's text. Safari on iOS ignores `select()` on a read-only field, but not a range. */
function selectAll(field: HTMLInputElement) {
  field.focus();
  field.select();
  field.setSelectionRange(0, field.value.length);
}

/** What to do to copy the selected link by hand: a touch screen has no Ctrl+C. */
function manualCopyHint(): string {
  const touch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  return touch
    ? "Touch and hold the selected link, then choose Copy."
    : "Press Ctrl+C (⌘C) to copy the selected link.";
}
