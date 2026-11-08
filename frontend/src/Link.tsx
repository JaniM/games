import { useOp } from "millpond/react";
import { type AnchorHTMLAttributes, type MouseEvent, useCallback } from "react";
import { pathChanged, pushPath } from "./features/router";

/**
 * Moves to another page of the site without reloading: puts the path in the address
 * bar and tells the router. (`pushState` fires no event, so it can't be left to listen.)
 */
export function useNavigate(): (path: string) => void {
  const setPath = useOp(pathChanged);
  return useCallback(
    (path: string) => {
      pushPath(path);
      setPath({ path });
    },
    [setPath],
  );
}

/**
 * A click the browser would turn into "go to this address in this tab". Anything else
 * (a new tab, a download, a modified click) is left to the browser.
 */
export function isPlainLeftClick(
  event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented">,
): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { to: string };

/** An ordinary link that, on a plain click, navigates inside the app. Middle clicks, Ctrl-clicks and the like still open a tab. */
export function Link({ to, onClick, target, ...rest }: LinkProps) {
  const navigate = useNavigate();
  return (
    <a
      {...rest}
      href={to}
      target={target}
      onClick={(event) => {
        onClick?.(event);
        if (target && target !== "_self") return;
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        navigate(to);
      }}
    />
  );
}
