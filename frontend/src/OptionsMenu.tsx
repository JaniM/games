import { type ReactNode, useEffect, useRef } from "react";

interface OptionsMenuProps {
  /** What the button says. */
  label?: string;
  /** The label is a name that may be long: it is cut short instead of growing the button. */
  clipLabel?: boolean;
  /** Which edge of the button the panel lines up with: the left, or the right for a menu in the right corner. */
  align?: "start" | "end";
  /**
   * What the panel holds. A function is given a way to close the menu, for an item that opens
   * something else (a dialog can't be inside the panel: what is in a closed `<details>` isn't shown).
   */
  children: ReactNode | ((close: () => void) => ReactNode);
}

/**
 * Whether a key press closes an open menu. Esc does, unless something inside has already used it
 * (a field that cancels its edit on Esc must not close the menu with the same press).
 */
export function closesMenu(event: { key: string; defaultPrevented: boolean }, open: boolean): boolean {
  return open && event.key === "Escape" && !event.defaultPrevented;
}

/**
 * A button that drops a small panel down from it, so that settings take no room on the page until
 * they are wanted ("Options" in the strip of a game page, the account in the top right corner). On
 * the browser's own `<details>`, which opens and closes with the button and tells a screen reader
 * that it does; the code here only adds the way out that a menu has: pressing outside it, or Esc,
 * closes it.
 */
export function OptionsMenu({ label = "Options", clipLabel = false, align = "start", children }: OptionsMenuProps) {
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const element = menu.current;
    if (!element) return;
    const pressed = (event: PointerEvent) => {
      if (element.open && event.target instanceof Node && !element.contains(event.target)) {
        element.open = false;
      }
    };
    const key = (event: KeyboardEvent) => {
      if (!closesMenu(event, element.open)) return;
      element.open = false;
      // The focus was inside the panel, which is hidden now: bring it back to the button.
      element.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", pressed);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", pressed);
      document.removeEventListener("keydown", key);
    };
  }, []);

  const close = () => {
    if (menu.current) menu.current.open = false;
  };

  return (
    <details ref={menu} className="options">
      <summary className="options-toggle">
        <span className={clipLabel ? "options-label options-label-clipped" : "options-label"}>{label}</span>
      </summary>
      <div className={align === "end" ? "options-panel options-panel-end" : "options-panel"}>
        {typeof children === "function" ? children(close) : children}
      </div>
    </details>
  );
}
