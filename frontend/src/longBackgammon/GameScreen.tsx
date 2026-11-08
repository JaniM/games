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
  isFull,
  seatOf,
} from "../features/game";
import { Board } from "./Board";
import type { TimedCue } from "./cues";
import { underDiceSpot } from "./geometry";
import { type Colour, colourOf } from "./layout";
import {
  barNameOf,
  lastThrowText,
  lastTurnText,
  resultText,
  turnText,
  viewerSeat,
} from "./status";
import { VolumeControl } from "./VolumeControl";

export type GameViewRow = RowOf<typeof gameViews>;
export type JoinRequestRow = RowOf<typeof joinRequests>;

export interface GameScreenProps {
  /** The game page's row, or undefined for the moment before the page has opened it. */
  view: GameViewRow | undefined;
  /** Who the browser is, or null while the session is being set up. */
  userId: string | null;
  join: JoinRequestRow | undefined;
  /** The link to give to the opponent. It is also how anyone else can watch. */
  inviteUrl: string;
  onJoin: () => void;
  onRoll: () => void;
  /** Takes back the last step of the turn in progress. */
  onUndo: () => void;
  /** Turns auto-play (this player's turns, played for them) on or off. */
  onAutoplay: (on: boolean) => void;
  /** Whether to offer auto-play at all. It is a development aid, so release builds leave it out. */
  showAutoplay: boolean;
  onSelect: (point: number | null) => void;
  onMove: (step: Step) => void;
  /** How loud the sounds are, from 0 (silent) to 1. */
  volume: number;
  onVolume: (volume: number) => void;
  /** Plays a sound. The caller applies the volume, and may play nothing. */
  onCue: (cue: TimedCue) => void;
}

const HOME = "/";

function Shell({ options, children }: { options?: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="page game-page">
      <div className="game-top">
        <p className="crumbs">
          <Link to={HOME}>← All games</Link>
        </p>
        {options}
      </div>
      <h1 className="game-title">Long backgammon</h1>
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
  inviteUrl,
  onJoin,
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
  const canAct = myTurn && connected && !view.busy;
  // Only a step of the turn in progress can be taken back: the one that ends the turn is final.
  const canUndo = canAct && state?.phase.type === "move" && state.phase.played.length > 0;
  const canJoin = userId !== null && mySeat === null && !isFull(snapshot);
  const waiting = !isFull(snapshot);

  const lastThrow = state ? lastThrowText(state) : "";
  const lastTurn = lastTurnText(snapshot, mySeat);
  const result = resultText(snapshot, mySeat);
  const turn = turnText(snapshot, mySeat);

  return (
    <Shell
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
      {!connected && (
        <p className="notice" role="status">
          Connection lost. Reconnecting…
        </p>
      )}

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
      {mySeat === null && userId !== null && !canJoin && (
        <p className="notice">You are watching this game.</p>
      )}

      <PlayerBar
        name={barNameOf(snapshot, opponent, mySeat)}
        colour={state ? colourOf(opponent, state, viewer) : null}
        off={state?.off[opponent] ?? 0}
        toMove={state !== null && !over && state.turn === opponent}
        empty={opponent >= snapshot.players.length}
      />
      <div className="board-wrap">
        <Board
          state={state}
          revision={snapshot.revision}
          viewer={viewer}
          selected={view.selected}
          interactive={canAct}
          player={mySeat !== null}
          onSelect={onSelect}
          onMove={onMove}
          onCue={onCue}
        />
        {/* One button at a time: the roll comes before there are steps to take back. */}
        {canAct && state?.phase.type === "roll" && (
          <button className="button under-dice" type="button" style={underDiceSpot()} onClick={onRoll}>
            Roll dice
          </button>
        )}
        {canUndo && (
          <button
            className="button button-quiet under-dice"
            type="button"
            style={underDiceSpot()}
            onClick={onUndo}
          >
            Undo
          </button>
        )}
      </div>
      <PlayerBar
        name={barNameOf(snapshot, viewer, mySeat)}
        colour={state ? colourOf(viewer, state, viewer) : null}
        off={state?.off[viewer] ?? 0}
        toMove={state !== null && !over && state.turn === viewer}
        empty={viewer >= snapshot.players.length}
      />

      <section className="controls" aria-label="Turn">
        {showAutoplay && mySeat !== null && state && !over && (
          <button
            className="button button-quiet"
            type="button"
            aria-pressed={view.auto}
            title="Plays your turns: a checker off the head when it can, otherwise a random legal move"
            onClick={() => onAutoplay(!view.auto)}
          >
            Auto-play
          </button>
        )}
        <p className="status" role="status" aria-live="polite">
          {result || turn}
        </p>
      </section>

      {view.error && (
        <p className="error" role="alert">
          {view.error}
        </p>
      )}
      {lastThrow && <p className="notice">{lastThrow}</p>}
      {lastTurn && <p className="muted">{lastTurn}</p>}
      {!state && (
        <p className="muted">Who plays White and moves first is decided when the second player joins.</p>
      )}
    </Shell>
  );
}

interface PlayerBarProps {
  name: string;
  /** Null before the game starts: nobody is White yet. */
  colour: Colour | null;
  off: number;
  toMove: boolean;
  empty: boolean;
}

function PlayerBar({ name, colour, off, toMove, empty }: PlayerBarProps) {
  return (
    <div className={toMove ? "player-bar player-bar-active" : "player-bar"}>
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
