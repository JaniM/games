import { feature } from "millpond";
import { persistSound } from "./effects";
import { setVolume, startSound } from "./ops";
import { soundSettings } from "./tables";

export const sound = feature({
  tables: { soundSettings },
  ops: { startSound, setVolume },
  effects: { persistSound },
});

// Components import definitions by value; they never need the assembled db.
export { setVolume, startSound } from "./ops";
export { loadVolume } from "./storage";
export { DEFAULT_VOLUME, SOUND_ID, soundSettings } from "./tables";
