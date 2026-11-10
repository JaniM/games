import { op } from "millpond";
import { DEFAULT_THEME, THEME_ID, type Theme, themeSettings } from "./tables";

/**
 * Sets up the theme once at startup, from whatever local storage held (null: nothing, so the
 * default). Does nothing if the theme has been set since.
 */
export const startTheme = op((tx, args: { stored: Theme | null }) => {
  if (tx.read(themeSettings.get(THEME_ID))) return;
  tx.insert(themeSettings, { id: THEME_ID, theme: args.stored ?? DEFAULT_THEME });
});

/** Picks the theme: light, dark, or `system` to follow the device. */
export const setTheme = op((tx, args: { theme: Theme }) => {
  tx.upsert(themeSettings, { id: THEME_ID, theme: args.theme });
});
