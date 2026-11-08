import type { KeyboardEvent, MouseEvent } from "react";
import type { LongBackgammonState, Seat, Step } from "../features/game";
import {
  type Colour,
  type PointView,
  colourOf,
  destinations,
  pointSlot,
  sourcePoints,
  viewerPoints,
} from "./layout";

// The board is an SVG in its own units, scaled to the width of the page. The viewer's
// head is top right and their home bottom right, whoever the viewer is (see `pointSlot`).

const WIDTH = 720;
const HEIGHT = 440;
const MARGIN = 12;
const POINT_WIDTH = 48;
const BAR_WIDTH = 28;
const TOP = 28; // where the bases of the top row sit
const BOTTOM = HEIGHT - 28;
const POINT_HEIGHT = 170;
const RADIUS = 19;
const STACK_STEP = 34;
/** More checkers than this on a point are drawn as five with the count on the top one. */
const MAX_STACK = 5;
const TRAY_X = 628;
const TRAY_WIDTH = 80;

const columnX = (column: number) =>
  MARGIN + column * POINT_WIDTH + (column >= 6 ? BAR_WIDTH : 0);

interface BoardProps {
  /** Null before the game starts: the board then shows the starting position. */
  state: LongBackgammonState | null;
  viewer: Seat;
  /** The point whose destinations are showing. */
  selected: number | null;
  /** The viewer may move now: it is their turn and nothing is in flight. */
  interactive: boolean;
  onSelect: (point: number | null) => void;
  onMove: (step: Step) => void;
}

export function Board({ state, viewer, selected, interactive, onSelect, onMove }: BoardProps) {
  const points = viewerPoints(state, viewer);
  const other = (1 - viewer) as Seat;
  const colours = {
    me: colourOf(viewer, state, viewer),
    them: colourOf(other, state, viewer),
  };

  const active = interactive && state !== null && state.phase.type === "move";
  // A selection only means something to the player who may move.
  const picked = active ? selected : null;
  const sources = active ? sourcePoints(state) : new Set<number>();
  const ways = active && picked !== null ? destinations(state, picked) : [];
  const targetDie = new Map<number, number>();
  for (const way of ways) if (way.to !== "off") targetDie.set(way.to, way.die);
  const bearOff = ways.filter((way) => way.to === "off");

  function pick(point: number) {
    const way = ways.find((w) => w.to === point);
    if (picked !== null && way) onMove({ from: picked, die: way.die });
    else if (sources.has(point)) onSelect(point);
    else onSelect(null);
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: clicking away is a mouse shortcut; the keyboard deselects by pressing the selected point again
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> groups form controls; this is a drawing with buttons in it
    <svg
      className="board"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="group"
      aria-label="Board"
      onClick={() => picked !== null && onSelect(null)}
    >
      <rect className="board-frame" x="0" y="0" width={WIDTH} height={HEIGHT} rx="12" />
      <rect
        className="board-bar"
        x={MARGIN + 6 * POINT_WIDTH}
        y={TOP - 10}
        width={BAR_WIDTH}
        height={HEIGHT - 2 * (TOP - 10)}
      />
      {points.map((point) => (
        <Point
          key={point.index}
          point={point}
          colours={colours}
          source={sources.has(point.index)}
          selected={point.index === picked}
          dieHere={targetDie.get(point.index) ?? null}
          onPick={pick}
        />
      ))}
      <Tray
        top
        count={state?.off[other] ?? 0}
        colour={colours.them}
        label="Opponent borne off"
      />
      <Tray
        count={state?.off[viewer] ?? 0}
        colour={colours.me}
        label="Your checkers borne off"
        dice={bearOff.map((way) => way.die)}
        onBearOff={(die) => picked !== null && onMove({ from: picked, die })}
      />
    </svg>
  );
}

/** Makes an SVG group act as a button, for the mouse and the keyboard. */
function pressable(label: string, press: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": label,
    onClick: (event: MouseEvent) => {
      // The board itself deselects on a click, so a press must not reach it.
      event.stopPropagation();
      press();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        press();
      }
    },
  };
}

interface PointProps {
  point: PointView;
  colours: { me: Colour; them: Colour };
  /** The mover may start a step here. */
  source: boolean;
  selected: boolean;
  /** The die that would land here from the selected point, or null. */
  dieHere: number | null;
  onPick: (point: number) => void;
}

function Point({ point, colours, source, selected, dieHere, onPick }: PointProps) {
  const { row, column } = pointSlot(point.index);
  const x = columnX(column);
  const top = row === "top";
  const base = top ? TOP : BOTTOM;
  const dir = top ? 1 : -1;
  const tip = base + dir * POINT_HEIGHT;
  const shade = (column + (top ? 0 : 1)) % 2 === 0 ? "a" : "b";
  const slotY = (i: number) => base + dir * (RADIUS + 2 + i * STACK_STEP);

  const shown = Math.min(point.count, MAX_STACK);
  const actionable = source || dieHere !== null;
  const colour = point.owner === "them" ? colours.them : colours.me;
  const label = dieHere !== null
    ? `Move to point ${point.index} with the ${dieHere}`
    : `Move a checker from point ${point.index}`;

  const className = [
    "point",
    selected && "point-selected",
    dieHere !== null && "point-target",
    source && !selected && "point-source",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <g className={className} {...(actionable || selected ? pressable(label, () => onPick(point.index)) : {})}>
      <path
        className={`tri tri-${shade}`}
        d={`M${x},${base} L${x + POINT_WIDTH},${base} L${x + POINT_WIDTH / 2},${tip} Z`}
      />
      {/* A wider target than the slim triangle is easy to hit with a thumb. */}
      <rect
        className="hit"
        x={x}
        y={top ? base : tip}
        width={POINT_WIDTH}
        height={POINT_HEIGHT}
      />
      <text
        className="point-number"
        x={x + POINT_WIDTH / 2}
        y={top ? TOP - 10 : BOTTOM + 20}
        textAnchor="middle"
      >
        {point.index}
      </text>
      {Array.from({ length: shown }, (_, i) => (
        <circle
          // biome-ignore lint/suspicious/noArrayIndexKey: the checkers on a point are interchangeable, so a slot's position is its identity
          key={i}
          className={`checker checker-${colour}`}
          cx={x + POINT_WIDTH / 2}
          cy={slotY(i)}
          r={RADIUS}
        />
      ))}
      {point.count > MAX_STACK && (
        <text
          className={`checker-count checker-count-${colour}`}
          x={x + POINT_WIDTH / 2}
          y={slotY(MAX_STACK - 1)}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {point.count}
        </text>
      )}
      {dieHere !== null && (
        <g className="ghost">
          <circle
            cx={x + POINT_WIDTH / 2}
            cy={slotY(Math.min(point.count, MAX_STACK - 1))}
            r={RADIUS - 2}
          />
          <text
            x={x + POINT_WIDTH / 2}
            y={slotY(Math.min(point.count, MAX_STACK - 1))}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {dieHere}
          </text>
        </g>
      )}
    </g>
  );
}

interface TrayProps {
  /** Drawn in the top right (the opponent's) rather than the bottom right. */
  top?: boolean;
  count: number;
  colour: Colour;
  label: string;
  /** The dice that would bear off the selected checker. */
  dice?: number[];
  onBearOff?: (die: number) => void;
}

const SLAB_HEIGHT = 10;
const SLAB_STEP = 11;

function Tray({ top = false, count, colour, label, dice = [], onBearOff }: TrayProps) {
  const y = top ? TOP : BOTTOM - POINT_HEIGHT;
  const slabY = (i: number) =>
    top ? y + 4 + i * SLAB_STEP : y + POINT_HEIGHT - 4 - SLAB_HEIGHT - i * SLAB_STEP;
  return (
    <g className="tray">
      <title>{`${label}: ${count}`}</title>
      <rect className="tray-box" x={TRAY_X} y={y} width={TRAY_WIDTH} height={POINT_HEIGHT} rx="6" />
      {Array.from({ length: count }, (_, i) => (
        <rect
          // biome-ignore lint/suspicious/noArrayIndexKey: the borne-off checkers are interchangeable, so a slab's position is its identity
          key={i}
          className={`checker checker-${colour}`}
          x={TRAY_X + 12}
          y={slabY(i)}
          width={TRAY_WIDTH - 24}
          height={SLAB_HEIGHT}
          rx="3"
        />
      ))}
      <text
        className="point-number"
        x={TRAY_X + TRAY_WIDTH / 2}
        y={top ? TOP - 10 : BOTTOM + 20}
        textAnchor="middle"
      >
        {`off · ${count}`}
      </text>
      {dice.map((die, i) => (
        <g
          key={die}
          className="bear-off"
          transform={`translate(${TRAY_X + 8} ${y + 14 + i * 44})`}
          {...pressable(`Bear off with the ${die}`, () => onBearOff?.(die))}
        >
          <rect width={TRAY_WIDTH - 16} height="36" rx="8" />
          <text x={(TRAY_WIDTH - 16) / 2} y="18" textAnchor="middle" dominantBaseline="central">
            {`off · ${die}`}
          </text>
        </g>
      ))}
    </g>
  );
}
