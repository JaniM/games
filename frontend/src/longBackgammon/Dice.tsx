import type { CSSProperties } from "react";
import { DIE_SIZE, diceSpots } from "./geometry";
import type { DieFace } from "./layout";

/** Pip centres on a 24 by 24 face, by die value. */
const PIPS: Record<number, [number, number][]> = {
  1: [[12, 12]],
  2: [[7, 7], [17, 17]],
  3: [[7, 7], [12, 12], [17, 17]],
  4: [[7, 7], [17, 7], [7, 17], [17, 17]],
  5: [[7, 7], [17, 7], [12, 12], [7, 17], [17, 17]],
  6: [[7, 6.5], [17, 6.5], [7, 12], [17, 12], [7, 17.5], [17, 17.5]],
};

// Where each die is thrown in from, and how far it spins on the way. They differ so that a
// pair doesn't move as one piece.
const THROWN_FROM = [
  [190, -50],
  [230, 40],
  [170, 60],
  [210, -30],
] as const;
const SPIN = [540, -450, 630, -360] as const;

/** A die centred on the origin of the group it is in. */
function Die({ value, used }: DieFace) {
  const half = DIE_SIZE / 2;
  return (
    // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: a <g> is a drawing group, not a control; the role says what it draws
    <g
      className={used ? "die die-used" : "die"}
      role="img"
      aria-label={used ? `${value}, played` : `${value}`}
      transform={`translate(${-half} ${-half}) scale(${DIE_SIZE / 24})`}
    >
      <rect x="1.5" y="1.5" width="21" height="21" rx="4" className="die-face" />
      {(PIPS[value] ?? []).map(([cx, cy]) => (
        <circle key={`${cx},${cy}`} cx={cx} cy={cy} r="2" className="die-pip" />
      ))}
    </g>
  );
}

interface DiceProps {
  faces: readonly DieFace[];
  /**
   * The dice were just thrown, so they tumble in. The animation runs when the group
   * appears, so the caller gives each throw its own key.
   */
  rolling: boolean;
}

/**
 * The dice on the board, lying in the middle strip of its right half: the dice of the turn
 * in progress, with the ones already played dimmed. They are part of the drawing, not
 * something to click, so a press goes through them to the board.
 */
export function Dice({ faces, rolling }: DiceProps) {
  if (faces.length === 0) return null;
  const spots = diceSpots(faces.length);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> groups form controls; this is a set of dice
    // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: a <g> is a drawing group, not a control; the role says what it draws
    <g
      className={rolling ? "dice dice-rolling" : "dice"}
      role="group"
      aria-label="Dice"
      pointerEvents="none"
    >
      {faces.map((face, i) => {
        const spot = spots[i];
        const [fromX, fromY] = THROWN_FROM[i % THROWN_FROM.length] ?? [0, 0];
        const style = {
          "--i": i,
          "--from-x": `${fromX}px`,
          "--from-y": `${fromY}px`,
          "--spin": `${SPIN[i % SPIN.length]}deg`,
        } as CSSProperties;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the faces never reorder, only change, so the position is the identity
          <g key={i} transform={`translate(${spot?.x ?? 0} ${spot?.y ?? 0}) rotate(${spot?.tilt ?? 0})`}>
            <g className="die-roll" style={style}>
              <Die {...face} />
            </g>
          </g>
        );
      })}
    </g>
  );
}
