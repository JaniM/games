import { useOp, useQuery } from "millpond/react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { type HexState, type Seat, submitAction } from "../features/game";
import { HEX_SIZE, stoneAt } from "../features/game/hex";
import { DEFAULT_VOLUME, SOUND_ID, soundSettings } from "../features/sound";
import { playCue } from "../longBackgammon/sounds";
import { type Placed, cuesFor, useHeld } from "./cues";
import { DOT, HEIGHT, MIDDLE, RADIUS, STONE, WIDTH, centre, corners, hexagon, pointsOf } from "./geometry";
import { type Colour, cellLabel, colourOf } from "./status";

export interface BoardProps {
  /** The game a stone is placed in: a press on a cell plays it (`submitAction`). */
  gameId: string;
  /** The game as it stands, or in a review the position shown. Null before the game starts. */
  state: HexState | null;
  /** The revision that showed `state`: a new one is a new position, which is heard and animated. */
  revision: number;
  /** The seat the board is drawn for: for the sounds that say whether the viewer won. */
  viewer: Seat;
  /** The viewer may play now: the empty cells are buttons. */
  interactive: boolean;
  /** The viewer plays in this game, rather than watches it: only then is a result a win or a loss. */
  player: boolean;
}

export function Board({ gameId, state, revision, viewer, interactive, player }: BoardProps) {
  const held = useHeld(state, revision);
  // At the volume set in the menu, which may be off.
  const volume = useQuery(soundSettings.get(SOUND_ID))?.volume ?? DEFAULT_VOLUME;

  // The sounds go with the stone, once per position. The one the board opened on has none, and nor
  // does the same position again with new labels.
  const heard = useRef(revision);
  const { placed, ended } = held;
  useEffect(() => {
    if (heard.current === revision) return;
    heard.current = revision;
    for (const { cue, afterMs } of cuesFor({ placed, ended, state, viewer, player })) playCue(cue, afterMs, volume);
  }, [revision, placed, ended, state, viewer, player, volume]);

  return <BoardView gameId={gameId} state={state} interactive={interactive} placed={placed} />;
}

interface BoardViewProps {
  gameId: string;
  state: HexState | null;
  interactive: boolean;
  /** The move that led to this position, if it can be followed with the eye. Its stone is set down. */
  placed: Placed | null;
}

const LINE = Array.from({ length: HEX_SIZE }, (_, index) => index);
const [A1, K1, K11, A11] = corners();

/**
 * The rhombus cut along its diagonals: each player's two edges in their colour, Red's on the top
 * and the bottom, Blue's on the left and the right. The cells cover all of it but the edges.
 */
const EDGES: { colour: Colour; points: string }[] = [
  { colour: "red", points: pointsOf([A1, K1, MIDDLE]) },
  { colour: "blue", points: pointsOf([K1, K11, MIDDLE]) },
  { colour: "red", points: pointsOf([K11, A11, MIDDLE]) },
  { colour: "blue", points: pointsOf([A11, A1, MIDDLE]) },
];

/** The board as a drawing of its props. `Board` works out what just happened; this only draws it. */
export function BoardView({ gameId, state, interactive, placed }: BoardViewProps) {
  // A game won by a chain shows it: the other stones step back.
  const chain = new Set((state?.chain ?? []).map(({ column, row }) => `${column},${row}`));
  const won = state?.phase.type === "over" && !state.phase.forfeited;
  // The colour of a stone placed now, which an empty cell shows faintly under the pointer.
  const mover = state && interactive ? colourOf(state, state.turn) : null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> groups form controls; this is a drawing with buttons in it
    <svg className="hex" viewBox={`0 0 ${WIDTH.toFixed(2)} ${HEIGHT.toFixed(2)}`} role="group" aria-label="Hex board">
      {EDGES.map(({ colour, points }) => (
        <polygon key={points} className={`hex-edge hex-edge-${colour}`} points={points} />
      ))}
      {LINE.map((row) =>
        LINE.map((column) => {
          const empty = state !== null && stoneAt(state, column, row) === null;
          if (state && mover && empty) {
            return (
              <OpenCell
                key={`${column},${row}`}
                gameId={gameId}
                column={column}
                row={row}
                colour={mover}
                label={cellLabel(state, column, row)}
              />
            );
          }
          return <polygon key={`${column},${row}`} className="hex-cell" points={hexagon(column, row)} />;
        }),
      )}
      {state &&
        LINE.map((row) =>
          LINE.map((column) => {
            const seat = stoneAt(state, column, row);
            if (seat === null) return null;
            const { x, y } = centre(column, row);
            const fresh = placed?.column === column && placed.row === row;
            const classes = [
              "hex-stone",
              `hex-stone-${colourOf(state, seat)}`,
              won && !chain.has(`${column},${row}`) && "hex-stone-faded",
              fresh && "hex-stone-fresh",
            ];
            // The title names the stone, for a screen reader, and under the pointer.
            return (
              <circle
                key={`${column},${row}`}
                className={classes.filter(Boolean).join(" ")}
                cx={x.toFixed(2)}
                cy={y.toFixed(2)}
                r={(RADIUS * STONE).toFixed(2)}
              >
                <title>{cellLabel(state, column, row)}</title>
              </circle>
            );
          }),
        )}
      {state?.last && <LastDot column={state.last.column} row={state.last.row} />}
    </svg>
  );
}

/** The dot on the stone the last move placed. */
function LastDot({ column, row }: { column: number; row: number }) {
  const { x, y } = centre(column, row);
  return <circle className="hex-last" cx={x.toFixed(2)} cy={y.toFixed(2)} r={(RADIUS * DOT).toFixed(2)} />;
}

interface OpenCellProps {
  gameId: string;
  column: number;
  row: number;
  /** The colour of the stone it would get, which shows under the pointer and the focus. */
  colour: Colour;
  /** What a screen reader calls the cell. */
  label: string;
}

/** Makes an SVG group act as a button, for the mouse and the keyboard, as the long backgammon board does. */
function pressable(label: string, press: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": label,
    onClick: press,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        press();
      }
    },
  };
}

/** An empty cell the player may put a stone on now. Pressing it does, which is final. */
export function OpenCell({ gameId, column, row, colour, label }: OpenCellProps) {
  const submit = useOp(submitAction);
  const { x, y } = centre(column, row);
  return (
    <g className="hex-open" {...pressable(label, () => submit({ gameId, action: { type: "place", column, row } }))}>
      <polygon className="hex-cell" points={hexagon(column, row)} />
      <circle
        className={`hex-ghost hex-stone-${colour}`}
        cx={x.toFixed(2)}
        cy={y.toFixed(2)}
        r={(RADIUS * STONE).toFixed(2)}
      />
    </g>
  );
}
