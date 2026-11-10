import { feature } from "millpond";
import { applyTheme, persistTheme } from "./effects";
import { setTheme, startTheme } from "./ops";
import { themeSettings } from "./tables";

export const theme = feature({
  tables: { themeSettings },
  ops: { startTheme, setTheme },
  effects: { persistTheme, applyTheme },
});

// Components import definitions by value; they never need the assembled db.
export { setTheme, startTheme } from "./ops";
export { loadTheme } from "./storage";
export { DEFAULT_THEME, THEMES, THEME_ID, type Theme, themeSettings } from "./tables";
