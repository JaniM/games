import { useEffect, useRef } from "react";
import type { BoardResult, Seat, UtttState } from "../features/game";
import type { TimedCue } from "../longBackgammon/cues";
import { type Placed, cuesFor, useHeld } from "./cues";
import { MarkIcon } from "./Mark";
import { boardLabel, cellLabel, markOf } from "./status";

export interface BoardProps {
  /** The game as it stands, or in a review the position shown. Null before the game starts. */
  state: UtttState | null;
  /** The revision that showed `state`: a new one is a new position, which is heard and animated. */
  revision: number;
  /** The seat the board is drawn for: for the sounds that say whether the viewer won. */
  viewer: Seat;
  /** The viewer may play now: the cells they may mark are buttons. */
  interactive: boolean;
  /** The viewer plays in this game, rather than watches it: only then is a result a win or a loss. */
  player: boolean;
  onPlay: (board: number, cell: number) => void;
  /** A sound goes with what just happened. The caller plays it, or not. */
  onCue: (cue: TimedCue) => void;
}

export function Board({ player, onCue, ...props }: BoardProps) {
  const { state, revision, viewer } = props;
  const held = useHeld(state, revision);

  // The sounds go with the mark, once per position. The one the board opened on has none, and
  // nor does the same position again with new labels.
  const heard = useRef(revision);
  const { placed, ended } = held;
  useEffect(() => {
    if (heard.current === revision) return;
    heard.current = revision;
    for (const timed of cuesFor({ placed, ended, state, viewer, player })) onCue(timed);
  }, [revision, placed, ended, state, viewer, player, onCue]);

  return <BoardView state={state} interactive={props.interactive} placed={placed} onPlay={props.onPlay} />;
}

interface BoardViewProps {
  state: UtttState | null;
  interactive: boolean;
  /** The mark that led to this position, if it can be followed with the eye. It is drawn in. */
  placed: Placed | null;
  onPlay: (board: number, cell: number) => void;
}

const OPEN: BoardResult = { type: "open" };
const NINE = Array.from({ length: 9 }, (_, index) => index);

/** The board as a drawing of its props. `Board` works out what just happened; this only draws it. */
export function BoardView({ state, interactive, placed, onPlay }: BoardViewProps) {
  const playing = state?.phase.type === "play";
  // Where the next mark must go. Shown to everyone, but it is the player's to do only on their turn.
  const targets = new Set(playing ? state.playable : []);
  // The boards of the line that won the game, if it was won by one.
  const winning = new Set(state?.line ?? []);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> groups form controls; this is a drawing with buttons in it
    <div className="ttt" role="group" aria-label="Ultimate tic-tac-toe board">
      {NINE.map((board) => {
        const result = state?.boards[board] ?? OPEN;
        const target = targets.has(board);
        const classes = [
          "ttt-board",
          `ttt-board-${result.type}`,
          target && "ttt-board-target",
          target && interactive && "ttt-board-yours",
          winning.has(board) && "ttt-board-line",
        ];
        return (
          // biome-ignore lint/a11y/useSemanticElements: a <fieldset> groups form controls; this is one board of a drawing
          <div
            key={board}
            className={classes.filter(Boolean).join(" ")}
            role="group"
            aria-label={state ? boardLabel(state, board) : `Board ${board + 1}`}
          >
            {NINE.map((cell) => {
              const seat = state?.cells[board]?.[cell] ?? null;
              const fresh = placed?.board === board && placed.cell === cell;
              const last = state?.last?.board === board && state.last.cell === cell;
              if (state && seat !== null) {
                const mark = markOf(state, seat);
                return (
                  <span
                    key={cell}
                    className={last ? "ttt-cell ttt-cell-last" : "ttt-cell"}
                    role="img"
                    aria-label={cellLabel(state, board, cell)}
                  >
                    <MarkIcon mark={mark} fresh={fresh} />
                  </span>
                );
              }
              // Only a cell that may be marked is a button: the others are not worth a stop on the way.
              if (state && interactive && target) {
                return (
                  <button
                    key={cell}
                    className="ttt-cell ttt-cell-open"
                    type="button"
                    aria-label={cellLabel(state, board, cell)}
                    onClick={() => onPlay(board, cell)}
                  />
                );
              }
              return <span key={cell} className="ttt-cell" aria-hidden="true" />;
            })}
            {state && result.type === "won" && (
              <span className="ttt-claim" aria-hidden="true">
                <MarkIcon
                  mark={markOf(state, result.seat)}
                  fresh={placed?.board === board}
                />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
