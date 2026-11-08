import { effect } from "millpond";
import { saveVolume } from "./storage";
import { soundSettings } from "./tables";

/** Keeps the volume in local storage, so that the next visit starts as this one ended. */
export const persistSound = effect({
  inputs: [soundSettings],
  watch: (q, task) =>
    q.each(soundSettings.all(), (row) =>
      task(
        async () => {
          saveVolume(row.volume);
        },
        { label: "save the volume" },
      ),
    ),
});
