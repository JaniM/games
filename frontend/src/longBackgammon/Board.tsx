import { type CSSProperties, type KeyboardEvent, type MouseEvent, useEffect, useRef } from "react";
import type { LongBackgammonState, Seat, Step } from "../features/game";
import { type TimedCue, cuesFor } from "./cues";
import { Dice } from "./Dice";
import {
  BAR_WIDTH,
  BOTTOM,
  HEIGHT,
  MARGIN,
  MAX_STACK,
  POINT_HEIGHT,
  POINT_WIDTH,
  RADIUS,
  SLAB_HEIGHT,
  TOP,
  TRAY_WIDTH,
  TRAY_X,
  WIDTH,
  type Xy,
  columnX,
  hopVector,
  slabCentre,
  slabY,
  slotCentre,
  slotY,
  trayY,
} from "./geometry";
import {
  type Colour,
  type PointView,
  colourOf,
  bearOffStep,
  destinations,
  diceFaces,
  pointNumber,
  pointSlot,
  pressOutcome,
  sourcePoints,
  viewerPoints,
} from "./layout";
import type { Motion, Place } from "./motion";
import { useMotion } from "./useMotion";

// The board is an SVG in its own units (see `geometry`), scaled to the width of the page.
// The viewer's head is top right and their home bottom right, whoever the viewer is (see
// `pointSlot`). The numbers on the points are the same for both players (see `pointNumber`).

type MoveMotion = Extract<Motion, { type: "move" }>;

interface BoardProps {
  /** Null before the game starts: the board then shows the starting position. */
  state: LongBackgammonState | null;
  /** The server's number for this position. A new one means something happened. */
  revision: number;
  viewer: Seat;
  /** The point whose destinations are showing. */
  selected: number | null;
  /** The viewer may move now: it is their turn and nothing is in flight. */
  interactive: boolean;
  /** The viewer plays in this game, rather than watches it: only then is a result a win or a loss. */
  player: boolean;
  onSelect: (point: number | null) => void;
  onMove: (step: Step) => void;
  /** A sound goes with what just happened. The caller plays it, or not. */
  onCue: (cue: TimedCue) => void;
}

export function Board({ player, onCue, ...props }: BoardProps) {
  const { state, revision, viewer } = props;
  const { motion, rolls, ended } = useMotion(state, revision, viewer);

  // The sounds go with the motion, once per position. The one the board opened on has none,
  // and nor does the same position again with new labels.
  const heard = useRef(revision);
  useEffect(() => {
    if (heard.current === revision) return;
    heard.current = revision;
    for (const timed of cuesFor({ motion, ended, state, viewer, player })) onCue(timed);
  }, [revision, motion, ended, state, viewer, player, onCue]);

  return <BoardView {...props} motion={motion} rolls={rolls} />;
}

interface BoardViewProps extends Omit<BoardProps, "player" | "onCue"> {
  /** What led to this position, if it can be followed with the eye. */
  motion: Motion | null;
  /** How many rolls this board has seen; 0 on a board that opened mid-game, whose dice lie still. */
  rolls: number;
}

/** The board as a drawing of its props. `Board` works out the motion; this only draws it. */
export function BoardView({
  state,
  revision,
  viewer,
  selected,
  interactive,
  motion,
  rolls,
  onSelect,
  onMove,
}: BoardViewProps) {
  const points = viewerPoints(state, viewer);
  const other = (1 - viewer) as Seat;
  const colours = {
    me: colourOf(viewer, state, viewer),
    them: colourOf(other, state, viewer),
  };
  // Nobody is White before the game starts; the viewer stands in, as in `colourOf`.
  const white = state?.white ?? viewer;
  const move = motion?.type === "move" ? motion : null;

  const active = interactive && state !== null && state.phase.type === "move";
  // A selection only means something to the player who may move.
  const picked = active ? selected : null;
  const sources = active ? sourcePoints(state) : new Set<number>();
  const ways = active && picked !== null ? destinations(state, picked) : [];
  const targetDie = new Map<number, number>();
  for (const way of ways) if (way.to !== "off") targetDie.set(way.to, way.die);
  const bearOff = bearOffStep(picked, ways);

  function press(on: "piece" | "background", point: number) {
    const outcome = pressOutcome(on, point, picked, ways, sources);
    if (outcome.type === "move") onMove(outcome.step);
    else if (outcome.type === "select") onSelect(outcome.point);
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
          number={pointNumber(point.index, viewer, white)}
          colours={colours}
          source={sources.has(point.index)}
          selected={point.index === picked}
          dieHere={targetDie.get(point.index) ?? null}
          arriving={move?.to.at === point.index ? move.to.count - 1 : null}
          onPress={press}
        />
      ))}
      <Tray
        top
        count={state?.off[other] ?? 0}
        colour={colours.them}
        label="Opponent borne off"
        arriving={move?.to.at === "off" && move.seat === other ? move.to.count - 1 : null}
      />
      <Tray
        count={state?.off[viewer] ?? 0}
        colour={colours.me}
        label="Your checkers borne off"
        canBearOff={bearOff !== null}
        onBearOff={() => bearOff && onMove(bearOff)}
        arriving={move?.to.at === "off" && move.seat === viewer ? move.to.count - 1 : null}
      />
      {state && <Dice key={rolls} faces={diceFaces(state)} rolling={rolls > 0} />}
      {move && (
        <Flight
          // A new revision is a new trip: the key starts its animation over.
          key={revision}
          move={move}
          colour={colourOf(move.seat, state, viewer)}
          trayTop={move.seat !== viewer}
        />
      )}
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
  /** What both players call this point. */
  number: number;
  colours: { me: Colour; them: Colour };
  /** The mover may start a step here. */
  source: boolean;
  selected: boolean;
  /** The die that would land here from the selected point, or null. */
  dieHere: number | null;
  /** The slot of a checker still flying in, which is not drawn until it lands, or null. */
  arriving: number | null;
  /** A press on the point's pieces, or on the rest of it. See `pressOutcome`. */
  onPress: (on: "piece" | "background", point: number) => void;
}

function Point({ point, number, colours, source, selected, dieHere, arriving, onPress }: PointProps) {
  const { row, column } = pointSlot(point.index);
  const x = columnX(column);
  const top = row === "top";
  const base = top ? TOP : BOTTOM;
  const dir = top ? 1 : -1;
  const tip = base + dir * POINT_HEIGHT;
  const shade = (column + (top ? 0 : 1)) % 2 === 0 ? "a" : "b";

  const colour = point.owner === "them" ? colours.them : colours.me;
  // The background is a button where a checker can land. Where one can only start, it still
  // selects with the mouse, but the pieces are the button for the keyboard.
  const onBackground = (event: MouseEvent) => {
    event.stopPropagation();
    onPress("background", point.index);
  };
  const background =
    dieHere !== null
      ? pressable(`Move to point ${number} with the ${dieHere}`, () => onPress("background", point.index))
      : source
        ? { onClick: onBackground }
        : {};

  const className = [
    "point",
    selected && "point-selected",
    dieHere !== null && "point-target",
    source && !selected && "point-source",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <g className={className}>
      <g className={source || dieHere !== null ? "point-bg point-bg-active" : "point-bg"} {...background}>
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
      </g>
      <text
        className="point-number"
        x={x + POINT_WIDTH / 2}
        y={top ? TOP - 10 : BOTTOM + 20}
        textAnchor="middle"
      >
        {number}
      </text>
      <g
        className={source ? "point-pieces point-pieces-active" : "point-pieces"}
        {...(source ? pressable(`Move a checker from point ${number}`, () => onPress("piece", point.index)) : {})}
      >
        {Array.from({ length: point.count }, (_, i) => (
          <circle
            // biome-ignore lint/suspicious/noArrayIndexKey: the checkers on a point are interchangeable, so a slot's position is its identity
            key={i}
            className={i === arriving ? `checker checker-${colour} checker-arriving` : `checker checker-${colour}`}
            cx={x + POINT_WIDTH / 2}
            cy={slotY(row, i, point.count)}
            r={RADIUS}
          />
        ))}
        {point.count > MAX_STACK && (
          <text
            className={`checker-count checker-count-${colour}`}
            x={x + POINT_WIDTH / 2}
            y={slotY(row, point.count - 1, point.count)}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {point.count}
          </text>
        )}
      </g>
      {dieHere !== null && (
        // The marker of where the checker would land. It is drawn over the pieces (on a full
        // stack it sits on the top one), and it moves the checker, like the background.
        // biome-ignore lint/a11y/noStaticElementInteractions: a mouse-only copy of the background button, which is the keyboard's
        <g className="ghost" onClick={onBackground}>
          {/* What catches the press: the drawn circle is only an outline, which a press in its
              middle passes through, to the piece below, and a piece only ever selects. On a full
              stack that piece is the top one, so the area covers all of it, its edge included. */}
          <circle
            className="ghost-hit"
            cx={x + POINT_WIDTH / 2}
            cy={slotY(row, point.count, point.count + 1)}
            r={point.count >= MAX_STACK ? RADIUS + 2 : RADIUS - 2}
          />
          <circle
            className="ghost-mark"
            cx={x + POINT_WIDTH / 2}
            cy={slotY(row, point.count, point.count + 1)}
            r={RADIUS - 2}
          />
          <text
            x={x + POINT_WIDTH / 2}
            y={slotY(row, point.count, point.count + 1)}
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
  /** The selected checker can be borne off: the tray offers the button for it. */
  canBearOff?: boolean;
  /** The slot of a checker still flying in, which is not drawn until it lands, or null. */
  arriving: number | null;
  onBearOff?: () => void;
}

function Tray({ top = false, count, colour, label, canBearOff = false, arriving, onBearOff }: TrayProps) {
  const y = trayY(top);
  return (
    <g className="tray">
      <title>{`${label}: ${count}`}</title>
      <rect className="tray-box" x={TRAY_X} y={y} width={TRAY_WIDTH} height={POINT_HEIGHT} rx="6" />
      {Array.from({ length: count }, (_, i) => (
        <rect
          // biome-ignore lint/suspicious/noArrayIndexKey: the borne-off checkers are interchangeable, so a slab's position is its identity
          key={i}
          className={i === arriving ? `checker checker-${colour} checker-arriving` : `checker checker-${colour}`}
          x={TRAY_X + 12}
          y={slabY(top, i)}
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
      {canBearOff && (
        <g
          className="bear-off"
          transform={`translate(${TRAY_X + 8} ${y + 14})`}
          {...pressable("Bear off", () => onBearOff?.())}
        >
          <rect width={TRAY_WIDTH - 16} height="36" rx="8" />
          <text x={(TRAY_WIDTH - 16) / 2} y="18" textAnchor="middle" dominantBaseline="central">
            Bear off
          </text>
        </g>
      )}
    </g>
  );
}

/** Where a checker is drawn when it stands at `place`. */
function spot(place: Place, trayTop: boolean): Xy {
  return place.at === "off"
    ? slabCentre(trayTop, place.count - 1)
    : slotCentre(place.at, place.count - 1, place.count);
}

/** In the tray a checker lies down as a slab: this flattens the round one to match. */
const SLAB_SCALE = { x: (TRAY_WIDTH - 24) / (2 * RADIUS), y: SLAB_HEIGHT / (2 * RADIUS) };

/**
 * A checker on its trip from one place to another, drawn above everything so that nothing
 * hides it on the way. It is gone when it lands: by then the checker at its resting place
 * is showing, and the two are drawn the same.
 *
 * It moves in an arc, as a lifted checker does, bulging towards the middle of the board (see
 * `hopVector`). Three nested groups each do one simple thing and the results add up, so that
 * none distorts another: the outer one carries the checker along the straight line between
 * the two places, the middle one pushes it off that line and back (a parabola in time), and
 * the inner one swells it at the top and, at the tray, lays it flat as a slab.
 */
function Flight({ move, colour, trayTop }: { move: MoveMotion; colour: Colour; trayTop: boolean }) {
  const from = spot(move.from, trayTop);
  const to = spot(move.to, trayTop);
  const scale = (place: Place) => (place.at === "off" ? SLAB_SCALE : { x: 1, y: 1 });
  const hop = hopVector(from, to);
  const style = {
    "--dx": `${from.x - to.x}px`,
    "--dy": `${from.y - to.y}px`,
    "--hop-x": `${hop.x}px`,
    "--hop-y": `${hop.y}px`,
    "--sx0": scale(move.from).x,
    "--sy0": scale(move.from).y,
    "--sx1": scale(move.to).x,
    "--sy1": scale(move.to).y,
  } as CSSProperties;
  return (
    // The outer group puts the origin at the landing place, so that the animation can scale about it.
    <g transform={`translate(${to.x} ${to.y})`} pointerEvents="none">
      <g className="flyer" style={style}>
        <g className="flyer-lift">
          <g className="flyer-body">
            <circle className={`checker checker-${colour}`} r={RADIUS} />
          </g>
        </g>
      </g>
    </g>
  );
}
