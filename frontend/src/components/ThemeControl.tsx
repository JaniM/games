import { THEMES, type Theme } from "../features/theme";

export interface ThemeControlProps {
  theme: Theme;
  onChange: (theme: Theme) => void;
}

const LABELS: Record<Theme, string> = { system: "Auto", light: "Light", dark: "Dark" };

/**
 * The choice of colours for the site: light, dark, or Auto, which follows the device. Radios, so
 * that a screen reader says which is picked and the arrow keys move between them; the picked one
 * is in the accent, which is for what is picked.
 */
export function ThemeControl({ theme, onChange }: ThemeControlProps) {
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
              onChange={() => onChange(option)}
            />
            <span className="theme-name">{LABELS[option]}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
