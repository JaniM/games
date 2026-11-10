import { useOp, useQuery } from "millpond/react";
import { type CSSProperties, type KeyboardEvent, type MouseEvent, useEffect, useRef } from "react";
import { type LongBackgammonState, type Seat, type Step, selectPoint, submitMoves } from "../features/game";
import { DEFAULT_VOLUME, SOUND_ID, soundSettings } from "../features/sound";
import { cuesFor } from "./cues";
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
  type Destination,
  type PointView,
  type Press,
  colourOf,
  bearOffSteps,
  destinations,
  diceFaces,
  diceWords,
  farthestBearOff,
  pointNumber,
  pointSlot,
  pressOutcome,
  sourcePoints,
  viewerPoints,
} from "./layout";
import type { Motion, Place } from "./motion";
import { playCue } from "./sounds";
import { useMotion } from "./useMotion";

// The board is an SVG in its own units (see `geometry`), scaled to the width of the page.
// The viewer's head is top right and their home bottom right, whoever the viewer is (see
// `pointSlot`). The points are numbered the same for both players (see `pointNumber`), but the
// numbers are not drawn: they name a point to a screen reader and in the text of a turn.

type MoveMotion = Extract<Motion, { type: "move" }>;

interface BoardProps {
  /** The game whose checkers the board moves: a press selects a point (`selectPoint`) or plays (`submitMoves`). */
  gameId: string;
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
}

export function Board({ player, ...props }: BoardProps) {
  const { state, revision, viewer } = props;
  const { motion, rolls, ended } = useMotion(state, revision, viewer);
  // At the volume set in the menu, which may be off.
  const volume = useQuery(soundSettings.get(SOUND_ID))?.volume ?? DEFAULT_VOLUME;

  // The sounds go with the motion, once per position. The one the board opened on has none,
  // and nor does the same position again with new labels.
  const heard = useRef(revision);
  useEffect(() => {
    if (heard.current === revision) return;
    heard.current = revision;
    for (const { cue, afterMs } of cuesFor({ motion, ended, state, viewer, player })) playCue(cue, afterMs, volume);
  }, [revision, motion, ended, state, viewer, player, volume]);

  return <BoardView {...props} motion={motion} rolls={rolls} />;
}

interface BoardViewProps extends Omit<BoardProps, "player"> {
  /** What led to this position, if it can be followed with the eye. */
  motion: Motion | null;
  /** How many rolls this board has seen; 0 on a board that opened mid-game, whose dice lie still. */
  rolls: number;
}

/** The board as a drawing of its props. `Board` works out the motion; this only draws it. */
export function BoardView({ gameId, state, revision, viewer, selected, interactive, motion, rolls }: BoardViewProps) {
  const select = useOp(selectPoint);
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
  const targets = new Map<number, Destination>();
  for (const way of ways) if (way.to !== "off") targets.set(way.to, way);
  // The tray bears off the picked checker or, with none picked, the farthest one it can.
  const bearOff =
    picked !== null ? bearOffSteps(picked, ways) : active ? farthestBearOff(state) : null;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: clicking away is a mouse shortcut; the keyboard deselects by pressing the selected point again
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> groups form controls; this is a drawing with buttons in it
    <svg
      className="board"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="group"
      aria-label="Board"
      onClick={() => picked !== null && select({ gameId, point: null })}
    >
      <rect className="board-frame" x="0" y="0" width={WIDTH} height={HEIGHT} rx="4" />
      {/* A fine line inside the edge, as on a made board. */}
      <rect
        className="board-inlay"
        x="6"
        y="6"
        width={WIDTH - 12}
        height={HEIGHT - 12}
        rx="2"
      />
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
          gameId={gameId}
          point={point}
          number={pointNumber(point.index, viewer, white)}
          colours={colours}
          source={sources.has(point.index)}
          selected={point.index === picked}
          target={targets.get(point.index) ?? null}
          arriving={move?.to.at === point.index ? move.to.count - 1 : null}
          piecesPress={pressOutcome("piece", point.index, picked, ways, sources)}
          backgroundPress={pressOutcome("background", point.index, picked, ways, sources)}
        />
      ))}
      <Tray
        gameId={gameId}
        top
        count={state?.off[other] ?? 0}
        colour={colours.them}
        label="Opponent borne off"
        arriving={move?.to.at === "off" && move.seat === other ? move.to.count - 1 : null}
      />
      <Tray
        gameId={gameId}
        count={state?.off[viewer] ?? 0}
        colour={colours.me}
        label="Your checkers borne off"
        bearOff={bearOff}
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
  gameId: string;
  point: PointView;
  /** What both players call this point. */
  number: number;
  colours: { me: Colour; them: Colour };
  /** The mover may start a step here. */
  source: boolean;
  selected: boolean;
  /** How the selected checker would land here, with one die or several, or null. */
  target: Destination | null;
  /** The slot of a checker still flying in, which is not drawn until it lands, or null. */
  arriving: number | null;
  /** What a press on the point's pieces does, and a press on the rest of it. See `pressOutcome`. */
  piecesPress: Press;
  backgroundPress: Press;
}

function Point({
  gameId,
  point,
  number,
  colours,
  source,
  selected,
  target,
  arriving,
  piecesPress,
  backgroundPress,
}: PointProps) {
  const select = useOp(selectPoint);
  const moveChecker = useOp(submitMoves);
  // A press that does nothing else takes back the selection.
  const press = (outcome: Press) => {
    if (outcome.type === "move") moveChecker({ gameId, steps: outcome.steps });
    else select({ gameId, point: outcome.type === "select" ? outcome.point : null });
  };
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
  const clickBackground = (event: MouseEvent) => {
    event.stopPropagation();
    press(backgroundPress);
  };
  const background =
    target !== null
      ? pressable(`Move to point ${number} with ${diceWords(target.steps)}`, () => press(backgroundPress))
      : source
        ? { onClick: clickBackground }
        : {};

  const className = [
    "point",
    selected && "point-selected",
    target !== null && "point-target",
    source && !selected && "point-source",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <g className={className} data-point={number}>
      <g className={source || target !== null ? "point-bg point-bg-active" : "point-bg"} {...background}>
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
      <g
        className={source ? "point-pieces point-pieces-active" : "point-pieces"}
        {...(source ? pressable(`Move a checker from point ${number}`, () => press(piecesPress)) : {})}
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
      {target !== null && (
        // The marker of where the checker would land. It is drawn over the pieces (on a full
        // stack it sits on the top one), and it moves the checker, like the background. It says
        // the die; for a combined move (several dice by this checker, one after the other) it
        // says them added up, is drawn with a solid line, and a tooltip spells them out.
        // biome-ignore lint/a11y/noStaticElementInteractions: a mouse-only copy of the background button, which is the keyboard's
        <g className={target.steps.length > 1 ? "ghost ghost-combo" : "ghost"} onClick={clickBackground}>
          {target.steps.length > 1 && (
            <title>{`${target.steps.map((step) => step.die).join(" + ")} = ${target.pips}`}</title>
          )}
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
            {target.pips}
          </text>
        </g>
      )}
    </g>
  );
}

interface TrayProps {
  gameId: string;
  /** Drawn in the top right (the opponent's) rather than the bottom right. */
  top?: boolean;
  count: number;
  colour: Colour;
  label: string;
  /**
   * The steps that bear a checker off to here (the selected one, or with none selected the
   * farthest), or null if none can be: then the tray is no button.
   */
  bearOff?: Step[] | null;
  /** The slot of a checker still flying in, which is not drawn until it lands, or null. */
  arriving: number | null;
}

function Tray({ gameId, top = false, count, colour, label, bearOff = null, arriving }: TrayProps) {
  const moveChecker = useOp(submitMoves);
  const y = trayY(top);
  return (
    <g className="tray">
      <title>{`${label}: ${count}`}</title>
      <rect
        className={bearOff !== null ? "tray-box tray-box-active" : "tray-box"}
        x={TRAY_X}
        y={y}
        width={TRAY_WIDTH}
        height={POINT_HEIGHT}
        rx="4"
      />
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
      {bearOff !== null && (
        // The whole tray is the button, over its borne-off checkers too, so that it is as easy to
        // hit as a point is; the label says what it does.
        <g className="bear-off" {...pressable("Bear off", () => moveChecker({ gameId, steps: bearOff }))}>
          <rect className="bear-off-hit" x={TRAY_X} y={y} width={TRAY_WIDTH} height={POINT_HEIGHT} rx="4" />
          <g transform={`translate(${TRAY_X + 8} ${y + 14})`}>
            <rect className="bear-off-label" width={TRAY_WIDTH - 16} height="36" rx="4" />
            <text x={(TRAY_WIDTH - 16) / 2} y="18" textAnchor="middle" dominantBaseline="central">
              Bear off
            </text>
          </g>
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
 * It moves in an arc, as a lifted checker does: down on the top side, up on the bottom side,
 * and in a straight line from one side to the other (see `hopVector`). Three nested groups
 * each do one simple thing and the results add up, so that none distorts another: the outer
 * one carries the checker along the straight line between the two places, the middle one
 * pushes it off that line and back (a parabola in time; no push at all on a trip from one
 * side to the other), and the inner one swells it at the top and, at the tray, lays it flat
 * as a slab.
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
