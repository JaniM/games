import { table } from "millpond";
import { z } from "zod";

/** The singleton key of the one `themeSettings` row. */
export const THEME_ID = "current";

/** What the person picks: a theme, or to follow the device (`system`). */
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** The theme before the person chooses: whatever the device is set to. */
export const DEFAULT_THEME: Theme = "system";

/**
 * Which colours this browser shows the site in. A single row, which the `persistTheme` effect
 * keeps in local storage and `applyTheme` puts on the page. Before `startTheme` has run there is
 * no row, and the theme is the default.
 */
export const themeSettings = table(
  z.object({ id: z.string(), theme: z.enum(THEMES) }),
  { key: "id" },
);
