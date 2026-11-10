import { type ReactNode, useEffect, useState } from "react";

/** How long a wait goes unremarked: most are over by then, and a flash of text would only flicker. */
export const LOADING_DELAY_MS = 1000;

export interface LoadingProps {
  className?: string;
  role?: "status";
  /** What to say; "Loading…" if left out. */
  children?: ReactNode;
}

/**
 * Says that something is loading or connecting, but only once it has taken longer than a second.
 * Mount it for as long as the wait lasts: it counts from when it mounts, and a wait that ends
 * takes it away before it says anything.
 */
export function Loading({ className, role, children = "Loading…" }: LoadingProps) {
  const [late, setLate] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setLate(true), LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  return late ? (
    <p className={className} role={role}>
      {children}
    </p>
  ) : null;
}
