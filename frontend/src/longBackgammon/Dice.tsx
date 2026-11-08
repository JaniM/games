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

function Die({ value, used }: DieFace) {
  return (
    <svg
      className={used ? "die die-used" : "die"}
      viewBox="0 0 24 24"
      role="img"
      aria-label={used ? `${value}, played` : `${value}`}
    >
      <rect x="1.5" y="1.5" width="21" height="21" rx="4" className="die-face" />
      {(PIPS[value] ?? []).map(([cx, cy]) => (
        <circle key={`${cx},${cy}`} cx={cx} cy={cy} r="2" className="die-pip" />
      ))}
    </svg>
  );
}

/** The dice of the turn in progress; the ones already played are dimmed. */
export function Dice({ faces }: { faces: readonly DieFace[] }) {
  if (faces.length === 0) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> groups form controls; this is a set of dice
    <div className="dice" role="group" aria-label="Dice">
      {faces.map((face, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the faces never reorder, only change, so the position is the identity
        <Die key={i} {...face} />
      ))}
    </div>
  );
}
