import { effect } from "millpond";
import { saveTheme } from "./storage";
import { type Theme, themeSettings } from "./tables";

/** Keeps the theme in local storage, so that the next visit starts as this one ended. */
export const persistTheme = effect({
  inputs: [themeSettings],
  watch: (q, task) =>
    q.each(themeSettings.all(), (row) =>
      task(
        async () => {
          saveTheme(row.theme);
        },
        { label: "save the theme" },
      ),
    ),
});

/**
 * Puts the theme on the page, as `data-theme` on the root element, which `styles.css` answers.
 * With none the page follows the device. (The first paint of a visit is the script in
 * `index.html`'s: this runs once the app has started.)
 */
export function showTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export const applyTheme = effect({
  inputs: [themeSettings],
  watch: (q, task) =>
    q.each(themeSettings.all(), (row) =>
      task(
        async () => {
          showTheme(row.theme);
        },
        { label: "show the theme" },
      ),
    ),
});
