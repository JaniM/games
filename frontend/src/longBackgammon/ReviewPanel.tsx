import { type ReactNode, useEffect } from "react";
import { type ReviewMove, moveForKey } from "../features/game";
import type { FrameText } from "./status";

export interface ReviewPanelProps {
  /** The positions are being asked for. With none shown yet, that is all there is to say. */
  loading: boolean;
  /** Why the positions could not be had, if they could not. */
  error: string | null;
  /** How many positions there are to step through. */
  count: number;
  /** The one on show, counted from 0; null while there are none. */
  index: number | null;
  /** What led to the position on show; null while there is none. */
  text: FrameText | null;
  /** The first position is not the beginning of the game: what was played before it was not kept. */
  partial: boolean;
  /** What the game itself is waiting for now, or "" once it is over. */
  live: string;
  /** Shows the position at this index. */
  onShow: (index: number) => void;
  /** Shows the position this many places on: 1 for the next, -1 for the one before. */
  onStep: (by: number) => void;
  onRetry: () => void;
  /** Goes back to the game. Null where the review can't be closed, because it is always there. */
  onClose: (() => void) | null;
}

/** Whether a key press belongs to a field the user is typing in, or to a slider that handles arrows itself. */
function isForField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * Stepping through a game, under the board: the buttons and the slider to move through the game,
 * and the way back to it where there is one. What led to the position on show, and how the game
 * ended, are for a screen reader only. The arrow
 * keys step, and Home and End go to the ends.
 */
export function ReviewPanel({
  loading,
  error,
  count,
  index,
  text,
  partial,
  live,
  onShow,
  onStep,
  onRetry,
  onClose,
}: ReviewPanelProps) {
  const last = count - 1;

  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isForField(event.target)) return;
      const move: ReviewMove | null = moveForKey(event.key);
      if (move === null || count === 0) return;
      event.preventDefault();
      if (move === "first") onShow(0);
      else if (move === "last") onShow(last);
      else onStep(move === "next" ? 1 : -1);
    };
    window.addEventListener("keydown", press);
    return () => window.removeEventListener("keydown", press);
  }, [count, last, onShow, onStep]);

  return (
    <section className="review" aria-label="Review">
      {/* What led to the position, and how the game ended, are not shown: the board says it. A screen
          reader still gets them as the user steps. */}
      {text ? (
        <p className="review-title visually-hidden" role="status" aria-live="polite">
          {text.title}
        </p>
      ) : loading ? (
        <p className="review-title" role="status">
          Loading the moves…
        </p>
      ) : error === null ? (
        <p className="review-title" role="status">
          Nothing was kept of this game.
        </p>
      ) : null}
      {text?.detail && <p className="review-detail visually-hidden">{text.detail}</p>}
      {error && (
        <p className="review-detail review-error" role="alert">
          {error}
        </p>
      )}
      {index !== null && (
        <div className="review-controls">
          <StepButton label="First position" disabled={index === 0} onClick={() => onShow(0)}>
            <path d="M3 3v10M12 3 7 8l5 5" />
          </StepButton>
          <StepButton label="Previous position" disabled={index === 0} onClick={() => onStep(-1)}>
            <path d="M10 3 5 8l5 5" />
          </StepButton>
          <StepButton label="Next position" disabled={index === last} onClick={() => onStep(1)}>
            <path d="m6 3 5 5-5 5" />
          </StepButton>
          <StepButton label="Latest position" disabled={index === last} onClick={() => onShow(last)}>
            <path d="M13 3v10M4 3l5 5-5 5" />
          </StepButton>
          <input
            className="review-slider"
            type="range"
            min={0}
            max={last}
            step={1}
            value={index}
            aria-label="Position"
            aria-valuetext={`${index + 1} of ${count}`}
            disabled={count < 2}
            onChange={(event) => onShow(Number(event.currentTarget.value))}
          />
          <span className="review-count">
            {index + 1} / {count}
          </span>
        </div>
      )}
      {partial && index !== null && (
        <p className="review-detail">What was played before this position was not kept.</p>
      )}
      {(live !== "" || error !== null || onClose !== null) && (
        <div className="review-foot">
          <p className="review-live">{live}</p>
          <div className="review-actions">
            {error !== null && (
              <button className="button button-quiet button-small" type="button" onClick={onRetry}>
                Try again
              </button>
            )}
            {onClose !== null && (
              <button className="button button-quiet button-small" type="button" onClick={onClose}>
                Close review
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

interface StepButtonProps {
  label: string;
  disabled: boolean;
  onClick: () => void;
  /** The icon's strokes, on a 16 by 16 grid. */
  children: ReactNode;
}

function StepButton({ label, disabled, onClick, children }: StepButtonProps) {
  return (
    <button
      className="button button-quiet review-step"
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        {children}
      </svg>
    </button>
  );
}
