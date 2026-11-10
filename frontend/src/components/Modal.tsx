import { type ReactNode, useEffect, useId, useRef } from "react";

interface ModalProps {
  /** The heading, which also names the dialog for screen readers. */
  title: string;
  /** Called when the player dismisses the dialog with Esc or by clicking outside it. */
  onClose: () => void;
  /** While true the dialog can't be dismissed, e.g. because a request is on its way. */
  locked?: boolean;
  children: ReactNode;
}

/**
 * A modal dialog, on the browser's own `<dialog>`: it traps focus, makes the rest of the
 * page inert and closes on Esc, with no code of ours. It is open for as long as it is
 * mounted, so the page renders it only while it should be showing.
 *
 * Inside, an element with `data-autofocus` gets the focus first; without one the browser
 * picks the first thing that can take it.
 */
export function Modal({ title, onClose, locked = false, children }: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element || element.open) return; // Already open: React ran the effect twice.
    element.showModal();
    element.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc dismisses it from the keyboard; clicking outside is a mouse shortcut
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby={titleId}
      // Esc asks to cancel; refusing it is how a locked dialog stays up.
      onCancel={(event) => {
        if (locked) event.preventDefault();
      }}
      // The dialog has closed itself, by Esc. Some browsers close on a second Esc however
      // the first was answered, so a locked dialog opens again.
      onClose={() => {
        if (locked) dialog.current?.showModal();
        else onClose();
      }}
      // The backdrop is part of the dialog element; its content is inside `.modal-body`,
      // so a click whose target is the dialog itself landed outside the content.
      onClick={(event) => {
        if (!locked && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-body">
        <h2 id={titleId} className="modal-title">
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}
