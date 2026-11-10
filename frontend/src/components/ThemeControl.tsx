import { useOp, useQuery } from "millpond/react";
import { DEFAULT_THEME, THEMES, THEME_ID, type Theme, setTheme, themeSettings } from "../features/theme";

const LABELS: Record<Theme, string> = { system: "Auto", light: "Light", dark: "Dark" };

/**
 * The choice of colours for the site: light, dark, or Auto, which follows the device. Radios, so
 * that a screen reader says which is picked and the arrow keys move between them; the picked one
 * is in the accent, which is for what is picked.
 */
export function ThemeControl() {
  const theme = useQuery(themeSettings.get(THEME_ID))?.theme ?? DEFAULT_THEME;
  const change = useOp(setTheme);
  return (
    <div className="theme" role="radiogroup" aria-labelledby="theme-label">
      <span className="theme-label" id="theme-label">
        Theme
      </span>
      <div className="theme-options">
        {THEMES.map((option) => (
          <label className="theme-option" key={option}>
            <input
              className="visually-hidden"
              type="radio"
              name="theme"
              value={option}
              checked={theme === option}
              onChange={() => change({ theme: option })}
            />
            <span className="theme-name">{LABELS[option]}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
