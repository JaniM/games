import { op } from "millpond";
import { DEFAULT_VOLUME, SOUND_ID, soundSettings } from "./tables";

const clamp = (volume: number) => Math.min(1, Math.max(0, volume));

/**
 * Sets up the volume once at startup, from whatever local storage held (null: nothing, so
 * the default). Does nothing if the volume has been set since.
 */
export const startSound = op((tx, args: { stored: number | null }) => {
  if (tx.read(soundSettings.get(SOUND_ID))) return;
  tx.insert(soundSettings, { id: SOUND_ID, volume: clamp(args.stored ?? DEFAULT_VOLUME) });
});

/** Sets the volume, from 0 (silent) to 1. A value outside that is cut to it. */
export const setVolume = op((tx, args: { volume: number }) => {
  tx.upsert(soundSettings, { id: SOUND_ID, volume: clamp(args.volume) });
});
