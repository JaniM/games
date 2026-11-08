import { type ReactNode, useEffect, useRef } from "react";

/**
 * An "Options" button that drops a small panel of settings down from it, so that settings
 * take no room on the page until they are wanted. On the browser's own `<details>`, which
 * opens and closes with the button and tells a screen reader that it does; the code here only
 * adds the way out that a menu has: pressing outside it, or Esc, closes it.
 */
export function OptionsMenu({ children }: { children: ReactNode }) {
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
      if (event.key !== "Escape" || !element.open) return;
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

  return (
    <details ref={menu} className="options">
      <summary className="options-toggle">Options</summary>
      <div className="options-panel">{children}</div>
    </details>
  );
}
