import { useOp, useQuery } from "millpond/react";
import { type ReactNode, useEffect } from "react";
import { Loading } from "../Loading";
import {
  type ReviewMove,
  closeReview,
  hasMovesIn,
  moveForKey,
  retryReview,
  reviews,
  showFrame,
  shownIndex,
  stepFrame,
} from "../../features/game";
import type { FrameText } from "./people";

export interface ReviewPanelProps {
  gameId: string;
  /** What led to the position on show; null while there is none. */
  text: FrameText | null;
  /** What the game itself is waiting for now, or "" once it is over. */
  live: string;
  /** The review can be closed, to go back to the game. Not where it is always there. */
  closable: boolean;
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
export function ReviewPanel({ gameId, text, live, closable }: ReviewPanelProps) {
  const review = useQuery(reviews.get(gameId));
  const show = useOp(showFrame);
  const step = useOp(stepFrame);
  const retry = useOp(retryReview);
  const close = useOp(closeReview);
  // The positions are being asked for. With none shown yet, that is all there is to say.
  const loading = review?.load === "loading";
  // Why the positions could not be had, if they could not.
  const error = review?.load === "failed" ? review.error : null;
  const count = review?.frames.length ?? 0;
  const last = count - 1;
  // The one on show, counted from 0; null while there are none.
  const index = review ? shownIndex(count, review.at) : null;
  // The first position is not the beginning of the game: what was played before it was not kept.
  const first = review?.frames[0];
  const partial = first !== undefined && hasMovesIn(first);

  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isForField(event.target)) return;
      const move: ReviewMove | null = moveForKey(event.key);
      if (move === null || count === 0) return;
      event.preventDefault();
      if (move === "first") show({ gameId, index: 0 });
      else if (move === "last") show({ gameId, index: last });
      else step({ gameId, by: move === "next" ? 1 : -1 });
    };
    window.addEventListener("keydown", press);
    return () => window.removeEventListener("keydown", press);
  }, [gameId, count, last, show, step]);

  return (
    <section className="review" aria-label="Review">
      {/* What led to the position, and how the game ended, are not shown: the board says it. A screen
          reader still gets them as the user steps. */}
      {text ? (
        <p className="review-title visually-hidden" role="status" aria-live="polite">
          {text.title}
        </p>
      ) : loading ? (
        <Loading className="review-title" role="status">
          Loading the moves…
        </Loading>
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
          <StepButton label="First position" disabled={index === 0} onClick={() => show({ gameId, index: 0 })}>
            <path d="M3 3v10M12 3 7 8l5 5" />
          </StepButton>
          <StepButton label="Previous position" disabled={index === 0} onClick={() => step({ gameId, by: -1 })}>
            <path d="M10 3 5 8l5 5" />
          </StepButton>
          <StepButton label="Next position" disabled={index === last} onClick={() => step({ gameId, by: 1 })}>
            <path d="m6 3 5 5-5 5" />
          </StepButton>
          <StepButton label="Latest position" disabled={index === last} onClick={() => show({ gameId, index: last })}>
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
            onChange={(event) => show({ gameId, index: Number(event.currentTarget.value) })}
          />
          <span className="review-count">
            {index + 1} / {count}
          </span>
        </div>
      )}
      {partial && index !== null && (
        <p className="review-detail">What was played before this position was not kept.</p>
      )}
      {(live !== "" || error !== null || closable) && (
        <div className="review-foot">
          <p className="review-live">{live}</p>
          <div className="review-actions">
            {error !== null && (
              <button className="button button-quiet button-small" type="button" onClick={() => retry({ gameId })}>
                Try again
              </button>
            )}
            {closable && (
              <button className="button button-quiet button-small" type="button" onClick={() => close({ gameId })}>
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
