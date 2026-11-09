import type { Mark } from "./status";

interface MarkIconProps {
  mark: Mark;
  /** The mark was just placed: it is drawn in, stroke by stroke, instead of just being there. */
  fresh?: boolean;
}

/**
 * An X or an O, as a drawing that fills its box. It takes the colour of its player from the
 * page (`--mark-x`, `--mark-o`) and has no text: a screen reader gets the label of its cell.
 * `pathLength` is 1 for every stroke, so that one animation draws any of them.
 */
export function MarkIcon({ mark, fresh = false }: MarkIconProps) {
  return (
    <svg
      className={`ttt-mark ttt-mark-${mark}${fresh ? " ttt-mark-fresh" : ""}`}
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
    >
      {mark === "x" ? (
        <>
          <path d="M25 25 75 75" pathLength={1} />
          <path d="M75 25 25 75" pathLength={1} />
        </>
      ) : (
        <circle cx="50" cy="50" r="26" pathLength={1} />
      )}
    </svg>
  );
}
